package io.deepmark;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.javalin.Javalin;
import io.javalin.http.BadRequestResponse;
import io.javalin.http.Context;
import io.javalin.http.ForbiddenResponse;
import io.javalin.http.NotFoundResponse;
import io.javalin.http.UnauthorizedResponse;

import java.security.SecureRandom;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

/** Worker groups and membership, shared by the console and task ACLs. */
public final class Groups {
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final ObjectMapper JSON = new ObjectMapper();
    private final Platform platform;

    public Groups(Platform platform) {
        this.platform = platform;
    }

    public void register(Javalin app) {
        app.get("/api/groups", ctx ->
            ctx.json(Map.of("groups", list(platform.auth.require(ctx)))));
        app.post("/api/groups", ctx -> {
            Auth.User user = platform.auth.require(ctx);
            requireWorker(user);
            String name = text(body(ctx), "name").strip();
            int length = name.codePointCount(0, name.length());
            if (length < 1 || length > 80 || name.codePoints().anyMatch(Character::isISOControl)) {
                throw new BadRequestResponse("小组名称应为 1–80 个字符，不能包含控制字符。");
            }
            String id = UUID.randomUUID().toString();
            String code = newCode();
            long now = System.currentTimeMillis();
            Map<String, Object> group = platform.db.transaction(connection -> {
                try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO \"groups\"(id,name,code,leader_id,created_at) VALUES(?,?,?,?,?)")) {
                    insert.setString(1, id);
                    insert.setString(2, name);
                    insert.setString(3, code);
                    insert.setString(4, user.id());
                    insert.setLong(5, now);
                    insert.executeUpdate();
                }
                try (PreparedStatement member = connection.prepareStatement(
                    "INSERT INTO group_members(group_id,user_id,joined_at) VALUES(?,?,?)")) {
                    member.setString(1, id);
                    member.setString(2, user.id());
                    member.setLong(3, now);
                    member.executeUpdate();
                }
                return detail(connection, id, user);
            });
            ctx.status(201).json(Map.of("group", group));
        });
        app.post("/api/groups/join", ctx -> {
            Auth.User user = platform.auth.require(ctx);
            requireWorker(user);
            String code = text(body(ctx), "code").strip().toUpperCase(Locale.ROOT);
            if (!code.matches("[0-9A-F]{12}")) {
                throw new BadRequestResponse("请输入有效的 12 位小组邀请码。");
            }
            Map<String, Object> group = platform.db.transaction(connection -> {
                String id;
                try (PreparedStatement find = connection.prepareStatement(
                    "SELECT id FROM \"groups\" WHERE code=?")) {
                    find.setString(1, code);
                    try (ResultSet row = find.executeQuery()) {
                        if (!row.next()) throw new NotFoundResponse("小组邀请码不存在。");
                        id = row.getString("id");
                    }
                }
                try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO group_members(group_id,user_id,joined_at) VALUES(?,?,?) " +
                    "ON CONFLICT(group_id,user_id) DO NOTHING")) {
                    insert.setString(1, id);
                    insert.setString(2, user.id());
                    insert.setLong(3, System.currentTimeMillis());
                    insert.executeUpdate();
                }
                return detail(connection, id, user);
            });
            ctx.json(Map.of("group", group));
        });
    }

    public List<Map<String, Object>> list(Auth.User user) {
        requireUser(user);
        if (!"worker".equals(user.role())) return List.of();
        return platform.db.read(connection -> {
            List<String> ids = new ArrayList<>();
            try (PreparedStatement query = connection.prepareStatement(
                "SELECT g.id FROM \"groups\" g JOIN group_members m ON m.group_id=g.id " +
                "WHERE m.user_id=? ORDER BY g.created_at,g.id")) {
                query.setString(1, user.id());
                try (ResultSet rows = query.executeQuery()) {
                    while (rows.next()) ids.add(rows.getString("id"));
                }
            }
            List<Map<String, Object>> groups = new ArrayList<>();
            for (String id : ids) groups.add(detail(connection, id, user));
            return groups;
        });
    }

    /** Details and the invite code are visible only to existing group members. */
    public Map<String, Object> detail(String id, Auth.User user) {
        requireUser(user);
        return platform.db.read(connection -> {
            requireMember(connection, user, id);
            return detail(connection, id, user);
        });
    }

    public void requireMember(Auth.User user, String groupId) {
        requireUser(user);
        platform.db.read(connection -> {
            requireMember(connection, user, groupId);
            return null;
        });
    }

    public void requireLeader(Auth.User user, String groupId) {
        requireWorker(user);
        platform.db.read(connection -> {
            try (PreparedStatement query = connection.prepareStatement(
                "SELECT 1 FROM \"groups\" g JOIN group_members m ON m.group_id=g.id " +
                "WHERE g.id=? AND g.leader_id=? AND m.user_id=?")) {
                query.setString(1, groupId);
                query.setString(2, user.id());
                query.setString(3, user.id());
                try (ResultSet row = query.executeQuery()) {
                    if (!row.next()) throw new ForbiddenResponse("只有该小组组长可以执行此操作。");
                }
            }
            return null;
        });
    }

    /** Used by task status after the caller has passed that task's access check. */
    public List<Map<String, Object>> members(String groupId) {
        if (groupId == null || groupId.isBlank()) return List.of();
        return platform.db.read(connection -> members(connection, groupId));
    }

    private static Map<String, Object> detail(Connection connection, String id, Auth.User user)
        throws SQLException {
        Map<String, Object> group = new LinkedHashMap<>();
        try (PreparedStatement query = connection.prepareStatement(
            "SELECT id,name,code,leader_id,created_at FROM \"groups\" WHERE id=?")) {
            query.setString(1, id);
            try (ResultSet row = query.executeQuery()) {
                if (!row.next()) throw new NotFoundResponse("小组不存在。");
                group.put("id", row.getString("id"));
                group.put("name", row.getString("name"));
                group.put("code", row.getString("code"));
                group.put("leaderId", row.getString("leader_id"));
                group.put("createdAt", row.getLong("created_at"));
                group.put("isLeader", user.id().equals(row.getString("leader_id")));
            }
        }
        group.put("members", members(connection, id));
        return group;
    }

    private static List<Map<String, Object>> members(Connection connection, String groupId)
        throws SQLException {
        List<Map<String, Object>> members = new ArrayList<>();
        try (PreparedStatement query = connection.prepareStatement(
            "SELECT u.id,u.username,u.name FROM group_members m JOIN users u ON u.id=m.user_id " +
            "WHERE m.group_id=? ORDER BY m.joined_at,u.id")) {
            query.setString(1, groupId);
            try (ResultSet rows = query.executeQuery()) {
                while (rows.next()) {
                    Map<String, Object> member = new LinkedHashMap<>();
                    member.put("id", rows.getString("id"));
                    member.put("username", rows.getString("username"));
                    member.put("name", rows.getString("name"));
                    members.add(member);
                }
            }
        }
        return members;
    }

    private static void requireMember(Connection connection, Auth.User user, String groupId)
        throws SQLException {
        try (PreparedStatement query = connection.prepareStatement(
            "SELECT 1 FROM group_members WHERE group_id=? AND user_id=?")) {
            query.setString(1, groupId);
            query.setString(2, user.id());
            try (ResultSet row = query.executeQuery()) {
                if (!row.next()) throw new ForbiddenResponse("只有小组成员可以访问该小组。");
            }
        }
    }

    private static void requireUser(Auth.User user) {
        if (user == null) throw new UnauthorizedResponse("请先登录。");
    }

    private static void requireWorker(Auth.User user) {
        requireUser(user);
        if (!"worker".equals(user.role())) {
            throw new ForbiddenResponse("只有标注人员可以创建或加入小组。");
        }
    }

    private static String newCode() {
        byte[] bytes = new byte[6];
        RANDOM.nextBytes(bytes);
        return HexFormat.of().withUpperCase().formatHex(bytes);
    }

    private static Map<String, Object> body(Context ctx) {
        byte[] bytes = ctx.bodyAsBytes();
        if (bytes.length > 8192) throw new BadRequestResponse("请求内容过长。");
        try {
            Map<String, Object> body = JSON.readValue(bytes, new TypeReference<>() {});
            if (body == null) throw new BadRequestResponse("请求格式无效。");
            return body;
        } catch (BadRequestResponse error) {
            throw error;
        } catch (Exception error) {
            throw new BadRequestResponse("请求格式无效。");
        }
    }

    private static String text(Map<String, Object> body, String key) {
        Object value = body.get(key);
        return value instanceof String text ? text : "";
    }
}
