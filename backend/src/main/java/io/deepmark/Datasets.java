package io.deepmark;

import io.javalin.Javalin;
import io.javalin.http.BadRequestResponse;
import io.javalin.http.ConflictResponse;
import io.javalin.http.Context;
import io.javalin.http.ForbiddenResponse;
import io.javalin.http.HttpResponseException;
import io.javalin.http.NotFoundResponse;
import io.javalin.http.UploadedFile;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

/** Published immutable source files and atomically claimed collaborative tasks. */
public final class Datasets {
    public record Source(Path path, byte[] bytes, String fingerprint, Map<String, Object> metadata) {}
    static final long MAX_UPLOAD_BYTES = 512L * 1024 * 1024;
    private final Platform platform;
    private final Path directory;

    public Datasets(Platform platform, Path directory) {
        this.platform = platform;
        try { Files.createDirectories(directory); this.directory = directory.toRealPath(); }
        catch (IOException error) { throw new IllegalStateException("Cannot create dataset directory", error); }
    }

    public void register(Javalin app) {
        app.get("/api/datasets", ctx -> ctx.json(Map.of("datasets", list(platform.auth.require(ctx)))));
        app.post("/api/datasets/upload", this::upload);
        app.post("/api/datasets/{id}/claim", ctx -> {
            Auth.User user = platform.auth.requireRole(ctx, "worker");
            Map<String, Object> body = json(ctx);
            ctx.json(Map.of("dataset", claim(user, ctx.pathParam("id"), text(body, "groupId"))));
        });
        app.post("/api/datasets/{id}/complete", ctx -> {
            Auth.User user = platform.auth.requireRole(ctx, "worker");
            Map<String, Object> body = json(ctx);
            Object revision = body.get("revision");
            if (!(revision instanceof Integer || revision instanceof Long) || ((Number) revision).longValue() < 0)
                throw new BadRequestResponse("修订号无效。");
            String id = ctx.pathParam("id");
            Map<String, Object> result = complete(user, id, ((Number) revision).longValue());
            platform.completed(id);
            ctx.json(Map.of("dataset", result));
        });
        app.get("/api/datasets/{id}/status", ctx -> {
            String id = ctx.pathParam("id");
            Auth.User user = platform.auth.require(ctx);
            Map<String, Object> dataset = metadata(id);
            if (!user.role().equals("worker") || !dataset.get("status").equals("unassigned")) platform.requireRead(user, id);
            Map<String, Object> result = new LinkedHashMap<>();
            dataset.put("progress", progress(id, ((Number) dataset.get("revision")).longValue()));
            result.put("dataset", dataset);
            Object group = dataset.get("groupId");
            result.put("members", group == null ? List.of() : platform.groups.members(group.toString()));
            result.put("history", history(id));
            ctx.json(result);
        });
        app.get("/api/datasets/{id}/download", this::download);
        app.head("/api/datasets/{id}/download", this::download);
    }

    public List<Map<String, Object>> list(Auth.User user) {
        return platform.db.read(connection -> {
            List<Map<String, Object>> result = new ArrayList<>();
            String filter = user.role().equals("dispatcher") ? "d.owner_id=?" : "(d.status='unassigned' OR EXISTS(SELECT 1 FROM group_members m WHERE m.group_id=d.group_id AND m.user_id=?))";
            try (PreparedStatement query = connection.prepareStatement("SELECT d.*,g.name group_name FROM datasets d LEFT JOIN groups g ON g.id=d.group_id WHERE " + filter + " ORDER BY d.created_at DESC,d.id")) {
                query.setString(1, user.id());
                try (ResultSet rows = query.executeQuery()) { while (rows.next()) result.add(row(connection, rows)); }
            }
            return result;
        });
    }

    public Map<String, Object> metadata(String id) {
        return platform.db.read(connection -> {
            try (PreparedStatement query = connection.prepareStatement("SELECT d.*,g.name group_name FROM datasets d LEFT JOIN groups g ON g.id=d.group_id WHERE d.id=?")) {
                query.setString(1, id);
                try (ResultSet row = query.executeQuery()) {
                    if (!row.next()) throw new NotFoundResponse("数据集不存在。");
                    return row(connection, row);
                }
            }
        });
    }

    private Map<String, Object> row(Connection connection, ResultSet row) throws Exception {
        Map<String, Object> data = new LinkedHashMap<>();
        String id = row.getString("id");
        data.put("id", id); data.put("name", row.getString("name"));
        data.put("folder", ""); data.put("size", row.getLong("size"));
        data.put("modified", Instant.ofEpochMilli(row.getLong("created_at")).toString());
        data.put("createdAt", row.getLong("created_at"));
        data.put("claimedAt", nullableLong(row, "claimed_at"));
        data.put("completedAt", nullableLong(row, "completed_at"));
        data.put("format", row.getString("format"));
        data.put("fingerprint", row.getString("fingerprint"));
        data.put("downloadUrl", "/api/datasets/" + id + "/download");
        data.put("status", row.getString("status"));
        data.put("groupId", row.getString("group_id")); data.put("groupName", row.getString("group_name"));
        data.put("ownerId", row.getString("owner_id")); data.put("claimedBy", row.getString("claimed_by"));
        data.put("projectId", null); data.put("revision", 0L);
        if (platform.tableExists("collab_projects")) {
            try (PreparedStatement project = connection.prepareStatement("SELECT id,revision FROM collab_projects WHERE dataset=? AND fingerprint=? ORDER BY rowid DESC LIMIT 1")) {
                project.setString(1, id); project.setString(2, row.getString("fingerprint"));
                try (ResultSet found = project.executeQuery()) {
                    if (found.next()) { data.put("projectId", found.getString("id")); data.put("revision", found.getLong("revision")); }
                }
            }
        }
        return data;
    }

    private static Long nullableLong(ResultSet row, String column) throws Exception {
        long value = row.getLong(column); return row.wasNull() ? null : value;
    }

    public Map<String, Object> claim(Auth.User user, String id, String groupId) {
        return platform.db.transaction(connection -> {
            platform.groups.requireLeader(user, groupId);
            Map<String, Object> current = metadata(id);
            if (!current.get("status").equals("unassigned")) throw new ConflictResponse("该数据集已被小组领取。");
            try (PreparedStatement update = connection.prepareStatement("UPDATE datasets SET group_id=?,claimed_by=?,claimed_at=?,status='in_progress' WHERE id=? AND status='unassigned' AND group_id IS NULL")) {
                update.setString(1, groupId); update.setString(2, user.id()); update.setLong(3, System.currentTimeMillis()); update.setString(4, id);
                if (update.executeUpdate() != 1) throw new ConflictResponse("该数据集已被其他小组领取。");
            }
            return metadata(id);
        });
    }

    public Map<String, Object> complete(Auth.User user, String id, Long expectedRevision) {
        if (expectedRevision == null || expectedRevision < 0) throw new BadRequestResponse("完工必须携带有效的当前修订号。");
        return platform.db.transaction(connection -> {
            Map<String, Object> current = metadata(id);
            Object group = current.get("groupId");
            if (group == null) throw new ConflictResponse("请先领取任务。");
            platform.groups.requireLeader(user, group.toString());
            if (current.get("status").equals("completed")) return current;
            platform.requireWrite(user, id);
            if (current.get("projectId") == null) throw new ConflictResponse("请先打开共享标注工程并保存成果。");
            if (((Number) current.get("revision")).longValue() != expectedRevision)
                throw new ConflictResponse("任务刚刚有新的标注，请刷新后再确认完工。");
            try (PreparedStatement update = connection.prepareStatement("UPDATE datasets SET status='completed',completed_at=? WHERE id=? AND status='in_progress' AND group_id=?")) {
                update.setLong(1, System.currentTimeMillis()); update.setString(2, id); update.setString(3, group.toString());
                if (update.executeUpdate() != 1) throw new ConflictResponse("任务状态已变化，请刷新。");
            }
            return metadata(id);
        });
    }

    private void upload(Context ctx) throws Exception {
        Auth.User user = platform.auth.requireRole(ctx, "dispatcher");
        UploadedFile upload = ctx.uploadedFile("file");
        if (upload == null) throw new BadRequestResponse("请选择 NIfTI 文件。");
        String original = upload.filename().replace('\\', '/');
        original = original.substring(original.lastIndexOf('/') + 1);
        if (!original.toLowerCase(Locale.ROOT).matches(".+\\.nii(?:\\.gz)?")) throw new BadRequestResponse("仅支持 .nii 或 .nii.gz 影像。");
        String title = ctx.formParam("name");
        String name = title == null || title.isBlank() ? original : title.trim();
        if (name.length() > 160 || name.codePoints().anyMatch(Character::isISOControl)) throw new BadRequestResponse("数据集名称过长或含控制字符。");
        Path temporary = Files.createTempFile(directory, ".upload-", ".part");
        Path saved = null;
        boolean published = false;
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long size = 0;
            try (InputStream input = upload.content(); OutputStream output = Files.newOutputStream(temporary)) {
                byte[] buffer = new byte[64 * 1024];
                for (int count; (count = input.read(buffer)) != -1;) {
                    size += count;
                    if (size > MAX_UPLOAD_BYTES) throw new HttpResponseException(413, "影像超过 512 MiB 上传上限。");
                    digest.update(buffer, 0, count); output.write(buffer, 0, count);
                }
            }
            if (size == 0) throw new BadRequestResponse("影像文件为空。");
            byte[] sourceBytes = Files.readAllBytes(temporary);
            Nifti.parse(sourceBytes);
            boolean compressed = sourceBytes.length > 1 && (sourceBytes[0] & 255) == 31 && (sourceBytes[1] & 255) == 139;
            String id = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(UUID.randomUUID().toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)));
            String filename = id + (compressed ? ".nii.gz" : ".nii");
            String fingerprint = HexFormat.of().formatHex(digest.digest());
            Path destination = directory.resolve(filename);
            Files.move(temporary, destination, StandardCopyOption.ATOMIC_MOVE);
            saved = destination;
            final long total = size;
            platform.db.transaction(connection -> {
                try (PreparedStatement insert = connection.prepareStatement("INSERT INTO datasets(id,owner_id,name,filename,size,fingerprint,format,status,created_at) VALUES(?,?,?,?,?,?,?,'unassigned',?)")) {
                    insert.setString(1, id); insert.setString(2, user.id()); insert.setString(3, name); insert.setString(4, filename);
                    insert.setLong(5, total); insert.setString(6, fingerprint); insert.setString(7, compressed ? "NIfTI · gzip" : "NIfTI"); insert.setLong(8, System.currentTimeMillis());
                    insert.executeUpdate();
                }
                return null;
            });
            published = true;
            ctx.status(201).json(Map.of("dataset", metadata(id)));
        } catch (IllegalArgumentException error) { throw new BadRequestResponse("影像格式无效：" + error.getMessage()); }
        finally { Files.deleteIfExists(temporary); if (!published && saved != null) Files.deleteIfExists(saved); }
    }

    public Source resolve(String id) {
        Map<String, Object> metadata = metadata(id);
        Path file = sourcePath(id);
        try {
            byte[] bytes = Files.readAllBytes(file);
            String actual = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
            if (!actual.equals(metadata.get("fingerprint"))) throw new HttpResponseException(410, "原始影像被替换，请联系发布者。");
            return new Source(file, bytes, actual, metadata);
        } catch (IOException error) { throw new HttpResponseException(410, "原始影像已移除。"); }
        catch (java.security.NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
    }

    private Path sourcePath(String id) {
        String filename = platform.db.read(connection -> {
            try (PreparedStatement query = connection.prepareStatement("SELECT filename FROM datasets WHERE id=?")) {
                query.setString(1, id);
                try (ResultSet row = query.executeQuery()) {
                    if (!row.next()) throw new NotFoundResponse("数据集不存在。");
                    return row.getString(1);
                }
            }
        });
        try {
            Path file = directory.resolve(filename).toRealPath();
            if (!file.getParent().equals(directory) || !Files.isRegularFile(file)) throw new NotFoundResponse("原始影像不存在。");
            return file;
        } catch (IOException error) { throw new HttpResponseException(410, "原始影像已移除。"); }
    }

    private void download(Context ctx) throws IOException {
        String id = ctx.pathParam("id");
        platform.requireRead(platform.auth.require(ctx), id);
        Path file = sourcePath(id);
        long size = Files.size(file), start = 0, end = size - 1;
        String range = ctx.header("Range");
        if (range != null) {
            if (!range.matches("bytes=(?:[0-9]+-[0-9]*|-[0-9]+)")) { rangeError(ctx, size); return; }
            String[] values = range.substring(6).split("-", -1);
            try {
                if (values[0].isEmpty()) {
                    long suffix = Long.parseLong(values[1]);
                    if (suffix <= 0) { rangeError(ctx, size); return; }
                    start = Math.max(0, size - suffix);
                } else {
                    start = Long.parseLong(values[0]);
                    if (!values[1].isEmpty()) end = Math.min(end, Long.parseLong(values[1]));
                }
            } catch (NumberFormatException error) { rangeError(ctx, size); return; }
            if (start > end || start >= size) { rangeError(ctx, size); return; }
            ctx.status(206).header("Content-Range", "bytes " + start + "-" + end + "/" + size);
        }
        // These lengths and byte ranges refer to the immutable source file.
        // A second HTTP gzip layer would invalidate Content-Length and truncate
        // incompressible .nii.gz downloads. Keep this response byte-for-byte.
        ctx.minSizeForCompression(Integer.MAX_VALUE);
        ctx.contentType("application/octet-stream");
        ctx.header("Accept-Ranges", "bytes").header("Cache-Control", "private, no-store");
        ctx.header("ETag", "\"" + metadata(id).get("fingerprint") + "\"");
        ctx.header("Content-Disposition", "attachment; filename=\"dataset" + (file.toString().endsWith(".gz") ? ".nii.gz" : ".nii") + "\"");
        ctx.res().setContentLengthLong(end - start + 1);
        if (ctx.req().getMethod().equals("HEAD")) return;
        InputStream input = Files.newInputStream(file);
        try { input.skipNBytes(start); ctx.result(new LimitedInputStream(input, end - start + 1)); }
        catch (Exception error) { input.close(); throw error; }
    }

    private static void rangeError(Context ctx, long size) { ctx.status(416).header("Content-Range", "bytes */" + size); }

    private List<Map<String, Object>> history(String datasetId) {
        if (!platform.tableExists("collab_events") || !platform.tableExists("collab_projects")) return List.of();
        return platform.db.read(connection -> {
            List<Map<String, Object>> history = new ArrayList<>();
            try (PreparedStatement query = connection.prepareStatement("SELECT e.revision,e.author,e.name,e.kind,e.time FROM collab_events e JOIN collab_projects p ON p.id=e.project JOIN datasets d ON d.id=p.dataset AND d.fingerprint=p.fingerprint WHERE d.id=? ORDER BY e.revision DESC LIMIT 100")) {
                query.setString(1, datasetId);
                try (ResultSet row = query.executeQuery()) {
                    while (row.next()) history.add(Map.of("revision", row.getLong("revision"), "author", row.getString("author"), "name", row.getString("name"), "kind", row.getString("kind"), "time", row.getString("time")));
                }
            }
            return history;
        });
    }

    private Map<String, Object> progress(String datasetId, long revision) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("revision", revision); result.put("operations", 0L); result.put("activeMembers", 0L);
        if (!platform.tableExists("collab_events") || !platform.tableExists("collab_projects")) return result;
        return platform.db.read(connection -> {
            try (PreparedStatement query = connection.prepareStatement("SELECT COUNT(*) operations,COUNT(DISTINCT e.author) active_members,MAX(e.time) last_activity FROM collab_events e JOIN collab_projects p ON p.id=e.project JOIN datasets d ON d.id=p.dataset AND d.fingerprint=p.fingerprint WHERE d.id=?")) {
                query.setString(1, datasetId);
                try (ResultSet row = query.executeQuery()) {
                    if (row.next()) {
                        result.put("operations", row.getLong("operations")); result.put("activeMembers", row.getLong("active_members"));
                        result.put("lastActivity", row.getString("last_activity"));
                    }
                }
            }
            return result;
        });
    }

    @SuppressWarnings("unchecked") private static Map<String, Object> json(Context ctx) {
        try {
            if (ctx.bodyAsBytes().length > 8192) throw new BadRequestResponse("请求过大。");
            Map<String, Object> body = Platform.JSON.readValue(ctx.body(), Map.class);
            if (body == null) throw new BadRequestResponse("请求格式无效。");
            return body;
        } catch (IOException error) { throw new BadRequestResponse("请求格式无效。"); }
    }
    private static String text(Map<String, Object> body, String key) {
        Object value = body.get(key);
        if (!(value instanceof String text) || text.isBlank() || text.length() > 160) throw new BadRequestResponse("请求字段无效：" + key);
        return text.trim();
    }

    private static final class LimitedInputStream extends FilterInputStream {
        private long remaining;
        LimitedInputStream(InputStream input, long remaining) { super(input); this.remaining = remaining; }
        @Override public int read() throws IOException { if (remaining == 0) return -1; int value = super.read(); if (value >= 0) remaining--; return value; }
        @Override public int read(byte[] bytes, int offset, int length) throws IOException {
            if (remaining == 0) return -1;
            int count = super.read(bytes, offset, (int) Math.min(length, remaining));
            if (count > 0) remaining -= count;
            return count;
        }
    }
}
