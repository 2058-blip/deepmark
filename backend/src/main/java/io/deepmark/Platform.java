package io.deepmark;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.core.StreamReadConstraints;
import io.javalin.Javalin;
import io.javalin.http.ForbiddenResponse;
import io.javalin.http.HttpResponseException;
import io.javalin.http.NotFoundResponse;
import java.nio.file.Path;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.Map;
import java.util.function.Consumer;

/** Platform accounts, dataset ownership and group ACL shared by HTTP and WebSocket handlers. */
public final class Platform implements AutoCloseable {
    public static final ObjectMapper JSON = new ObjectMapper();
    static { JSON.getFactory().setStreamReadConstraints(StreamReadConstraints.builder().maxStringLength(48 * 1024 * 1024).build()); }
    public final ObjectMapper mapper = JSON;
    public final Database db;
    public final Auth auth;
    public final Datasets datasets;
    public final Groups groups;
    private volatile Consumer<String> completionListener = id -> {};

    public Platform(Path stateDir, Path datasetDir) {
        db = new Database(stateDir.resolve("deepmark.sqlite"));
        auth = new Auth(db);
        groups = new Groups(this);
        datasets = new Datasets(this, datasetDir);
    }

    public void install(Javalin app) {
        auth.routes(app);
        groups.register(app);
        datasets.register(app);
    }

    public Map<String, Object> dataset(String id) { return datasets.metadata(id); }

    public void requireRead(Auth.User user, String datasetId) {
        if (user == null) throw new io.javalin.http.UnauthorizedResponse("请先登录。");
        Map<String, Object> dataset = datasets.metadata(datasetId);
        if (user.role().equals("dispatcher")) {
            if (!user.id().equals(dataset.get("ownerId"))) throw new ForbiddenResponse("只能查看自己发布的数据集。");
            return;
        }
        Object group = dataset.get("groupId");
        if (group == null) throw new ForbiddenResponse("请由组长先为小组领取数据集。");
        groups.requireMember(user, group.toString());
    }

    public void requireWrite(Auth.User user, String datasetId) {
        requireRead(user, datasetId);
        if (!user.role().equals("worker")) throw new ForbiddenResponse("派活账户只能只读查看标注。");
        if (!datasets.metadata(datasetId).get("status").equals("in_progress"))
            throw new HttpResponseException(423, "任务已完成，标注已锁定。");
    }

    public void requireLeader(Auth.User user, String datasetId) {
        requireWrite(user, datasetId);
        Object group = datasets.metadata(datasetId).get("groupId");
        if (group == null) throw new NotFoundResponse("数据集尚未领取。");
        groups.requireLeader(user, group.toString());
    }

    public void onDatasetCompleted(Consumer<String> listener) { completionListener = listener; }
    void completed(String id) { completionListener.accept(id); }

    public boolean tableExists(String name) {
        return db.read(connection -> {
            try (PreparedStatement query = connection.prepareStatement("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")) {
                query.setString(1, name);
                try (ResultSet row = query.executeQuery()) { return row.next(); }
            }
        });
    }

    @Override public void close() { db.close(); }
}
