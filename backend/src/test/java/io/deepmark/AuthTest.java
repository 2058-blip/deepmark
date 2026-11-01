package io.deepmark;

import io.javalin.http.BadRequestResponse;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import javax.crypto.Cipher;
import javax.crypto.spec.OAEPParameterSpec;
import javax.crypto.spec.PSource;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PublicKey;
import java.security.spec.MGF1ParameterSpec;
import java.security.spec.X509EncodedKeySpec;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.Arrays;
import java.util.Base64;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class AuthTest {
    private static KeyPair keys;

    @BeforeAll static void keys() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
        generator.initialize(4096);
        keys = generator.generateKeyPair();
    }

    @Test void passwordHashUsesSaltAndVerifiesOnlyCorrectPassword() {
        byte[] firstSalt = new byte[24];
        byte[] secondSalt = new byte[24];
        Arrays.fill(firstSalt, (byte) 7);
        Arrays.fill(secondSalt, (byte) 8);
        char[] clear = "correct horse battery staple".toCharArray();
        byte[] first = Auth.hashPassword(clear, firstSalt, Auth.PASSWORD_ITERATIONS);
        byte[] second = Auth.hashPassword("correct horse battery staple".toCharArray(), secondSalt, Auth.PASSWORD_ITERATIONS);
        assertEquals(32, first.length);
        assertFalse(Arrays.equals(first, second));
        assertTrue(Auth.verifyPassword("correct horse battery staple", first, firstSalt, Auth.PASSWORD_ITERATIONS));
        assertFalse(Auth.verifyPassword("incorrect horse battery staple", first, firstSalt, Auth.PASSWORD_ITERATIONS));
        assertArrayEquals(new char[clear.length], clear, "Hashing must clear the mutable password copy");
    }

    @Test void challengeIsSpkiAndPasswordEnvelopeCannotBeReplayed() throws Exception {
        Auth auth = new Auth(null, Clock.systemUTC(), keys);
        Map<String, Object> challenge = auth.challenge();
        String id = (String) challenge.get("challengeId");
        PublicKey exported = KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(
            Base64.getDecoder().decode((String) challenge.get("publicKey"))));
        assertArrayEquals(keys.getPublic().getEncoded(), exported.getEncoded());
        String password = "有空格 and Unicode 密码";
        String encrypted = encrypt(id, password, MGF1ParameterSpec.SHA256);
        assertEquals(password, auth.decryptPassword(id, encrypted));
        assertThrows(BadRequestResponse.class, () -> auth.decryptPassword(id, encrypted));
    }

    @Test void challengeRejectsExpiryAndMismatchedEnvelope() throws Exception {
        MutableClock clock = new MutableClock();
        Auth auth = new Auth(null, clock, keys);
        String expired = (String) auth.challenge().get("challengeId");
        String encrypted = encrypt(expired, "secure-password", MGF1ParameterSpec.SHA256);
        clock.now += Auth.CHALLENGE_TTL_MS;
        assertThrows(BadRequestResponse.class, () -> auth.decryptPassword(expired, encrypted));
        String live = (String) auth.challenge().get("challengeId");
        String wrongEnvelope = encrypt("another-challenge", "secure-password", MGF1ParameterSpec.SHA256);
        assertThrows(BadRequestResponse.class, () -> auth.decryptPassword(live, wrongEnvelope));
        assertThrows(BadRequestResponse.class, () -> auth.decryptPassword(live,
            encrypt(live, "secure-password", MGF1ParameterSpec.SHA256)));
    }

    @Test void failedDecryptionConsumesChallengeAndDoesNotAcceptMgf1Sha1() throws Exception {
        Auth auth = new Auth(null, Clock.systemUTC(), keys);
        String id = (String) auth.challenge().get("challengeId");
        String incompatible = encrypt(id, "secure-password", MGF1ParameterSpec.SHA1);
        assertThrows(BadRequestResponse.class, () -> auth.decryptPassword(id, incompatible));
        assertThrows(BadRequestResponse.class, () -> auth.decryptPassword(id,
            encrypt(id, "secure-password", MGF1ParameterSpec.SHA256)));
    }

    @Test void rsaEnvelopeCanCarryMaximumAsciiPassword() throws Exception {
        Auth auth = new Auth(null, Clock.systemUTC(), keys);
        String id = (String) auth.challenge().get("challengeId");
        String password = "a".repeat(128);
        assertEquals(password, auth.decryptPassword(id, encrypt(id, password, MGF1ParameterSpec.SHA256)));
    }

    @Test void originValidationChecksSchemeHostPortAndRejectsOpaqueOrigins() {
        assertTrue(Auth.sameOrigin("https://example.com", "https", "example.com:443"));
        assertTrue(Auth.sameOrigin("http://localhost:8787", "http", "localhost:8787"));
        assertFalse(Auth.sameOrigin("https://example.com.evil.invalid", "https", "example.com"));
        assertFalse(Auth.sameOrigin("http://example.com", "https", "example.com"));
        assertFalse(Auth.sameOrigin("https://example.com:444", "https", "example.com"));
        assertFalse(Auth.sameOrigin("null", "https", "example.com"));
        assertFalse(Auth.sameOrigin("https://attacker@example.com", "https", "example.com"));
        assertFalse(Auth.sameOrigin("https://example.com/path", "https", "example.com"));
    }

    @Test void cookieUsesHttpOnlySameSiteAndParsesCompleteHeader() {
        String token = "a".repeat(43);
        String header = Auth.cookie(token, 60, true);
        assertTrue(header.contains("HttpOnly"));
        assertTrue(header.contains("SameSite=Lax"));
        assertTrue(header.contains("; Secure"));
        assertEquals(token, Auth.cookieToken("unrelated=foo; " + Auth.COOKIE_NAME + "=" + token));
        assertNull(Auth.cookieToken(Auth.COOKIE_NAME + "=short"));
        assertNull(Auth.cookieToken("unrelated=" + token));
        assertNull(Auth.cookieToken(null));
    }

    private static String encrypt(String id, String password, MGF1ParameterSpec mgf) throws Exception {
        Cipher cipher = Cipher.getInstance("RSA/ECB/OAEPPadding");
        cipher.init(Cipher.ENCRYPT_MODE, keys.getPublic(), new OAEPParameterSpec(
            "SHA-256", "MGF1", mgf, PSource.PSpecified.DEFAULT));
        String json = "{\"challengeId\":\"" + id + "\",\"password\":\"" + password + "\"}";
        return Base64.getEncoder().encodeToString(cipher.doFinal(json.getBytes(StandardCharsets.UTF_8)));
    }

    private static final class MutableClock extends Clock {
        long now = 1_700_000_000_000L;
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return this; }
        @Override public Instant instant() { return Instant.ofEpochMilli(now); }
        @Override public long millis() { return now; }
    }
}
