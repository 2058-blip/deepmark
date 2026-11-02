package io.deepmark;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.javalin.Javalin;
import io.javalin.http.BadRequestResponse;
import io.javalin.http.Context;
import io.javalin.http.ForbiddenResponse;
import io.javalin.http.HttpResponseException;
import io.javalin.http.UnauthorizedResponse;

import javax.crypto.Cipher;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.OAEPParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.PSource;
import java.net.InetAddress;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.spec.MGF1ParameterSpec;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Clock;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

/** Account authentication shared by the HTTP API and collaboration sockets. */
public final class Auth {
    public record User(String id, String username, String name, String role) {}

    static final int PASSWORD_ITERATIONS = 600_000;
    static final long CHALLENGE_TTL_MS = 120_000;
    static final long SESSION_TTL_MS = 30L * 24 * 60 * 60 * 1000;
    static final String COOKIE_NAME = "deepmark_session";
    private static final int MAX_CHALLENGES = 4096;
    private static final int MAX_AUTH_BODY_BYTES = 8192;
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final OAEPParameterSpec OAEP = new OAEPParameterSpec(
        "SHA-256", "MGF1", MGF1ParameterSpec.SHA256, PSource.PSpecified.DEFAULT);

    private final Database database;
    private final Clock clock;
    private final KeyPair keys;
    private final long challengeTtlMs;
    private final boolean allowHttp;
    private final Map<String, Long> challenges = new HashMap<>();

    public Auth(Database database) {
        this(database, Clock.systemUTC(), createKeys());
    }

    Auth(Database database, Clock clock, KeyPair keys) {
        this(database, clock, keys, "1".equals(System.getenv("DEEPMARK_ALLOW_HTTP")));
    }

    Auth(Database database, Clock clock, KeyPair keys, boolean allowHttp) {
        this.database = database;
        this.clock = clock;
        this.keys = keys;
        this.challengeTtlMs = configuredChallengeTtl();
        this.allowHttp = allowHttp;
    }

    public void routes(Javalin app) {
        app.get("/api/auth/policy", ctx -> {
            noStore(ctx);
            ctx.json(Map.of("allowHttp", allowHttp));
        });
        app.get("/api/auth/challenge", ctx -> {
            requireSecureTransport(ctx);
            noStore(ctx);
            ctx.json(challenge());
        });
        app.get("/api/auth/me", ctx -> {
            noStore(ctx);
            Map<String, Object> response = new LinkedHashMap<>();
            response.put("user", current(ctx));
            ctx.json(response);
        });
        app.post("/api/auth/register", ctx -> {
            checkMutation(ctx);
            Map<String, Object> body = body(ctx);
            String password = decryptPassword(text(body, "challengeId"), text(body, "encryptedPassword"));
            String username = username(text(body, "username"));
            String name = displayName(text(body, "name"), username);
            String role = text(body, "role");
            if (!role.equals("worker") && !role.equals("dispatcher")) {
                throw new BadRequestResponse("请选择标注人员或数据发布人员账号。");
            }
            validatePassword(password);
            byte[] salt = new byte[24];
            RANDOM.nextBytes(salt);
            byte[] hash = hashPassword(password.toCharArray(), salt, PASSWORD_ITERATIONS);
            long now = clock.millis();
            String id = UUID.randomUUID().toString();
            User user = new User(id, username, name, role);
            String previousToken = cookieToken(ctx.header("Cookie"));
            String token;
            try {
                token = database.transaction(connection -> {
                    try (PreparedStatement insert = connection.prepareStatement(
                        "INSERT INTO users(id,username,name,role,password_hash,password_salt,password_iterations,created_at) VALUES(?,?,?,?,?,?,?,?)")) {
                        insert.setString(1, id);
                        insert.setString(2, username);
                        insert.setString(3, name);
                        insert.setString(4, role);
                        insert.setBytes(5, hash);
                        insert.setBytes(6, salt);
                        insert.setInt(7, PASSWORD_ITERATIONS);
                        insert.setLong(8, now);
                        insert.executeUpdate();
                    } catch (SQLException error) {
                        if (isDuplicateUsername(error)) {
                            throw new HttpResponseException(409, "该用户名已被使用。");
                        }
                        throw error;
                    }
                    return issueSession(connection, id, now, previousToken);
                });
            } finally {
                Arrays.fill(hash, (byte) 0);
            }
            setCookie(ctx, token);
            noStore(ctx);
            ctx.status(201).json(Map.of("user", user));
        });
        app.post("/api/auth/login", ctx -> {
            checkMutation(ctx);
            Map<String, Object> body = body(ctx);
            String password = decryptPassword(text(body, "challengeId"), text(body, "encryptedPassword"));
            String username = username(text(body, "username"));
            validatePassword(password);
            Credentials credentials = database.read(connection -> {
                try (PreparedStatement query = connection.prepareStatement(
                    "SELECT id,username,name,role,password_hash,password_salt,password_iterations FROM users WHERE username=?")) {
                    query.setString(1, username);
                    try (ResultSet rows = query.executeQuery()) {
                        if (!rows.next()) return null;
                        return new Credentials(readUser(rows), rows.getBytes("password_hash"),
                            rows.getBytes("password_salt"), rows.getInt("password_iterations"));
                    }
                }
            });
            // Use the same expensive verifier for unknown accounts to avoid a username timing oracle.
            byte[] expected = credentials == null ? new byte[32] : credentials.hash();
            byte[] salt = credentials == null ? new byte[24] : credentials.salt();
            int iterations = credentials == null ? PASSWORD_ITERATIONS : credentials.iterations();
            boolean matches = verifyPassword(password, expected, salt, iterations);
            if (credentials == null || !matches) throw new UnauthorizedResponse("用户名或密码错误。");
            String previousToken = cookieToken(ctx.header("Cookie"));
            String token = database.transaction(connection -> issueSession(connection,
                credentials.user().id(), clock.millis(), previousToken));
            setCookie(ctx, token);
            noStore(ctx);
            ctx.json(Map.of("user", credentials.user()));
        });
        app.post("/api/auth/logout", ctx -> {
            checkMutation(ctx);
            String token = cookieToken(ctx.header("Cookie"));
            if (token != null) database.transaction(connection -> {
                try (PreparedStatement delete = connection.prepareStatement("DELETE FROM sessions WHERE token_hash=?")) {
                    delete.setString(1, digestToken(token));
                    delete.executeUpdate();
                }
                return null;
            });
            ctx.header("Set-Cookie", cookie("", 0, secureCookie(ctx)));
            noStore(ctx);
            ctx.json(Map.of("ok", true));
        });
    }

    public User current(Context context) {
        return fromCookie(context.header("Cookie"));
    }

    public User require(Context context) {
        User user = current(context);
        if (user == null) throw new UnauthorizedResponse("请先登录账号。");
        return user;
    }

    public User requireRole(Context context, String role) {
        User user = require(context);
        if (!user.role().equals(role)) throw new ForbiddenResponse("当前账号无权执行此操作。");
        return user;
    }

    public void checkMutation(Context context) {
        requireSecureTransport(context);
        csrf(context);
    }

    /** Browser WebSocket upgrades carry Origin and cookies, but cannot add custom headers. */
    public void checkWebSocket(Context context) {
        requireSecureTransport(context);
        checkOrigin(context);
    }

    /** Accepts the complete Cookie header, including multiple cookies. */
    public User fromCookie(String cookieHeader) {
        String token = cookieToken(cookieHeader);
        if (token == null) return null;
        return database.read(connection -> {
            try (PreparedStatement query = connection.prepareStatement(
                "SELECT u.id,u.username,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?")) {
                query.setString(1, digestToken(token));
                query.setLong(2, clock.millis());
                try (ResultSet rows = query.executeQuery()) {
                    return rows.next() ? readUser(rows) : null;
                }
            }
        });
    }

    /** Apply to every authenticated mutation route, including collaboration fallbacks. */
    public static void csrf(Context context) {
        if (!"1".equals(context.header("X-Deepmark-Request"))) {
            throw new ForbiddenResponse("请求缺少同源校验标记。");
        }
        checkOrigin(context);
    }

    private static void checkOrigin(Context context) {
        String origin = context.header("Origin");
        String site = context.header("Sec-Fetch-Site");
        if (origin != null && !sameOrigin(origin, requestScheme(context), context.host())) {
            throw new ForbiddenResponse("请求来源无效。");
        }
        if (site != null && !site.equals("same-origin") && !site.equals("none")) {
            throw new ForbiddenResponse("请求来源无效。");
        }
    }

    static boolean sameOrigin(String origin, String scheme, String host) {
        try {
            URI actual = URI.create(origin);
            URI expected = URI.create(scheme + "://" + host);
            return actual.getUserInfo() == null && actual.getQuery() == null
                && actual.getFragment() == null && (actual.getRawPath() == null || actual.getRawPath().isEmpty())
                && actual.getScheme() != null && actual.getScheme().equalsIgnoreCase(expected.getScheme())
                && actual.getHost() != null && actual.getHost().equalsIgnoreCase(expected.getHost())
                && effectivePort(actual) == effectivePort(expected);
        } catch (IllegalArgumentException error) {
            return false;
        }
    }

    private static int effectivePort(URI uri) {
        return uri.getPort() >= 0 ? uri.getPort() : "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
    }

    synchronized Map<String, Object> challenge() {
        long now = clock.millis();
        challenges.entrySet().removeIf(entry -> entry.getValue() <= now);
        if (challenges.size() >= MAX_CHALLENGES) {
            throw new HttpResponseException(429, "登录请求较多，请稍后重试。");
        }
        String id = randomToken();
        long expires = now + challengeTtlMs;
        challenges.put(id, expires);
        return Map.of("challengeId", id, "publicKey", Base64.getEncoder().encodeToString(keys.getPublic().getEncoded()),
            "algorithm", "RSA-OAEP-256", "expiresAt", expires);
    }

    String decryptPassword(String challengeId, String encryptedPassword) {
        Long expires;
        synchronized (this) {
            expires = challenges.remove(challengeId);
        }
        if (expires == null || expires <= clock.millis()) {
            throw new BadRequestResponse("登录挑战已失效，请重新提交。");
        }
        if (encryptedPassword.isEmpty() || encryptedPassword.length() > 1024) {
            throw new BadRequestResponse("密码密文无效。");
        }
        byte[] plaintext = null;
        try {
            Cipher cipher = Cipher.getInstance("RSA/ECB/OAEPPadding");
            cipher.init(Cipher.DECRYPT_MODE, keys.getPrivate(), OAEP);
            plaintext = cipher.doFinal(Base64.getDecoder().decode(encryptedPassword));
            String json = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(plaintext)).toString();
            Map<String, Object> payload = JSON.readValue(json, new TypeReference<Map<String, Object>>() {});
            if (!challengeId.equals(text(payload, "challengeId"))) throw new BadRequestResponse("登录挑战不匹配。");
            if (!(payload.get("password") instanceof String)) throw new BadRequestResponse("密码密文无效。");
            return text(payload, "password");
        } catch (BadRequestResponse error) {
            throw error;
        } catch (Exception error) {
            throw new BadRequestResponse("密码密文无效，请重新提交。");
        } finally {
            if (plaintext != null) Arrays.fill(plaintext, (byte) 0);
        }
    }

    static byte[] hashPassword(char[] password, byte[] salt, int iterations) {
        if (salt == null || salt.length < 16 || iterations < 100_000 || iterations > 5_000_000) {
            throw new IllegalArgumentException("Invalid password verifier parameters");
        }
        PBEKeySpec spec = new PBEKeySpec(password, salt, iterations, 256);
        try {
            return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
        } catch (GeneralSecurityException error) {
            throw new IllegalStateException("Password hashing is unavailable", error);
        } finally {
            spec.clearPassword();
            Arrays.fill(password, '\0');
        }
    }

    static boolean verifyPassword(String password, byte[] expected, byte[] salt, int iterations) {
        if (expected == null || expected.length != 32) return false;
        byte[] actual = hashPassword(password.toCharArray(), salt, iterations);
        try {
            return MessageDigest.isEqual(actual, expected);
        } finally {
            Arrays.fill(actual, (byte) 0);
        }
    }

    private static void validatePassword(String password) {
        if (password.length() < 8 || password.length() > 128 || password.getBytes(StandardCharsets.UTF_8).length > 256
            || password.codePoints().anyMatch(Character::isISOControl)) {
            throw new BadRequestResponse("密码需为 8–128 个字符，UTF-8 编码不超过 256 字节，且不含控制字符。");
        }
    }

    private static String username(String value) {
        String normalized = value.strip().toLowerCase(Locale.ROOT);
        if (!normalized.matches("[a-z0-9_.-]{3,40}")) {
            throw new BadRequestResponse("用户名需为 3–40 位英文字母、数字、下划线、点或短横线。");
        }
        return normalized;
    }

    private static String displayName(String value, String fallback) {
        String name = value.strip();
        if (name.isEmpty()) name = fallback;
        if (name.length() > 60 || name.codePoints().anyMatch(Character::isISOControl)) {
            throw new BadRequestResponse("显示名称不能超过 60 个字符或包含控制字符。");
        }
        return name;
    }

    private String issueSession(Connection connection, String userId, long now, String previousToken) throws SQLException {
        String token = randomToken();
        // Replacing this browser's account also invalidates its existing WebSocket credential.
        if (previousToken != null) {
            try (PreparedStatement previous = connection.prepareStatement("DELETE FROM sessions WHERE token_hash=?")) {
                previous.setString(1, digestToken(previousToken));
                previous.executeUpdate();
            }
        }
        try (PreparedStatement expired = connection.prepareStatement("DELETE FROM sessions WHERE expires_at<=?")) {
            expired.setLong(1, now);
            expired.executeUpdate();
        }
        try (PreparedStatement insert = connection.prepareStatement("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)")) {
            insert.setString(1, digestToken(token));
            insert.setString(2, userId);
            insert.setLong(3, now + SESSION_TTL_MS);
            insert.executeUpdate();
        }
        return token;
    }

    static String cookieToken(String header) {
        if (header == null || header.length() > 16_384) return null;
        for (String part : header.split(";")) {
            String cookie = part.strip();
            int equals = cookie.indexOf('=');
            if (equals > 0 && cookie.substring(0, equals).equals(COOKIE_NAME)) {
                String token = cookie.substring(equals + 1);
                return token.matches("[A-Za-z0-9_-]{43}") ? token : null;
            }
        }
        return null;
    }

    private static String digestToken(String token) {
        try {
            return java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(token.getBytes(StandardCharsets.US_ASCII)));
        } catch (GeneralSecurityException error) {
            throw new IllegalStateException(error);
        }
    }

    private static String randomToken() {
        byte[] token = new byte[32];
        RANDOM.nextBytes(token);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(token);
    }

    private static KeyPair createKeys() {
        try {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
            generator.initialize(4096, RANDOM);
            return generator.generateKeyPair();
        } catch (GeneralSecurityException error) {
            throw new IllegalStateException("Password encryption is unavailable", error);
        }
    }

    private static long configuredChallengeTtl() {
        String configured = System.getenv("DEEPMARK_CHALLENGE_TTL_SECONDS");
        if (configured == null || configured.isBlank()) return CHALLENGE_TTL_MS;
        try {
            long seconds = Long.parseLong(configured);
            if (seconds >= 1 && seconds <= 300) return seconds * 1000;
        } catch (NumberFormatException ignored) {
            // Invalid security configuration must not silently weaken the challenge lifetime.
        }
        throw new IllegalArgumentException("DEEPMARK_CHALLENGE_TTL_SECONDS must be between 1 and 300");
    }

    private static User readUser(ResultSet row) throws SQLException {
        return new User(row.getString("id"), row.getString("username"), row.getString("name"), row.getString("role"));
    }

    private static boolean isDuplicateUsername(SQLException error) {
        return error.getErrorCode() == 19 && error.getMessage() != null
            && error.getMessage().contains("users.username");
    }

    private static Map<String, Object> body(Context context) {
        byte[] bytes = context.bodyAsBytes();
        if (bytes.length > MAX_AUTH_BODY_BYTES) throw new HttpResponseException(413, "认证请求过大。");
        try {
            Map<String, Object> body = JSON.readValue(bytes, new TypeReference<Map<String, Object>>() {});
            if (body == null || body.containsKey("password")) throw new BadRequestResponse("请使用加密密码登录。");
            return body;
        } catch (BadRequestResponse error) {
            throw error;
        } catch (Exception error) {
            throw new BadRequestResponse("认证请求格式无效。");
        }
    }

    private static String text(Map<String, Object> data, String key) {
        Object value = data.get(key);
        return value instanceof String string ? string : "";
    }

    private static boolean secureCookie(Context context) {
        return "1".equals(System.getenv("COOKIE_SECURE")) || "https".equals(requestScheme(context));
    }

    private static String requestScheme(Context context) {
        if ("https".equalsIgnoreCase(context.scheme())) return "https";
        if (loopback(context.req().getRemoteAddr())
            && "https".equalsIgnoreCase(context.header("X-Forwarded-Proto"))) return "https";
        return "http";
    }

    void requireSecureTransport(Context context) {
        if (allowHttp) return;
        if ("https".equals(requestScheme(context))) return;
        String host;
        try {
            host = URI.create("http://" + context.host()).getHost();
        } catch (IllegalArgumentException error) {
            host = null;
        }
        if (loopback(context.req().getRemoteAddr()) && ("localhost".equalsIgnoreCase(host) || loopback(host))) return;
        throw new ForbiddenResponse("账号登录需要 HTTPS；HTTP 仅允许本机开发访问。");
    }

    private static boolean loopback(String address) {
        if (address == null || !address.matches("[0-9a-fA-F:.\\[\\]]+")) return false;
        try {
            return InetAddress.getByName(address).isLoopbackAddress();
        } catch (Exception error) {
            return false;
        }
    }

    static String cookie(String token, long maxAge, boolean secure) {
        return COOKIE_NAME + "=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + maxAge
            + (secure ? "; Secure" : "");
    }

    private static void setCookie(Context context, String token) {
        context.header("Set-Cookie", cookie(token, SESSION_TTL_MS / 1000, secureCookie(context)));
    }

    private static void noStore(Context context) {
        context.header("Cache-Control", "no-store");
    }

    private record Credentials(User user, byte[] hash, byte[] salt, int iterations) {}
}
