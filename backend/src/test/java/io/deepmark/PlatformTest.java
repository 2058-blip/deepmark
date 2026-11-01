package io.deepmark;

import io.javalin.http.HttpResponseException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Path;
import java.sql.PreparedStatement;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import static org.junit.jupiter.api.Assertions.*;

class PlatformTest {
    @TempDir Path temporary;

    @Test void concurrentGroupClaimsHaveExactlyOneWinner() throws Exception {
        try (Platform platform = fixture()) {
            Auth.User first = user("first", "worker"), second = user("second", "worker");
            CountDownLatch start = new CountDownLatch(1);
            var pool = Executors.newFixedThreadPool(2);
            try {
                var a = pool.submit(() -> { start.await(); return tryClaim(platform, first, "group-a"); });
                var b = pool.submit(() -> { start.await(); return tryClaim(platform, second, "group-b"); });
                start.countDown();
                List<Integer> outcomes = new ArrayList<>(List.of(a.get(10, TimeUnit.SECONDS), b.get(10, TimeUnit.SECONDS)));
                outcomes.sort(Integer::compareTo);
                assertEquals(List.of(200, 409), outcomes);
                Map<String, Object> dataset = platform.dataset("dataset");
                assertEquals("in_progress", dataset.get("status"));
                assertTrue(List.of("group-a", "group-b").contains(dataset.get("groupId")));
            } finally { pool.shutdownNow(); }
        }
    }

    @Test void ownerCanMonitorButCannotEditAndOtherGroupsCannotRead() {
        try (Platform platform = fixture()) {
            Auth.User leader = user("first", "worker"), owner = user("owner", "dispatcher");
            platform.datasets.claim(leader, "dataset", "group-a");
            assertDoesNotThrow(() -> platform.requireRead(owner, "dataset"));
            assertDoesNotThrow(() -> platform.requireWrite(leader, "dataset"));
            assertThrows(HttpResponseException.class, () -> platform.requireWrite(owner, "dataset"));
            assertThrows(HttpResponseException.class, () -> platform.requireRead(user("second", "worker"), "dataset"));
            assertThrows(HttpResponseException.class, () -> platform.requireRead(user("other-owner", "dispatcher"), "dataset"));
            assertTrue(platform.datasets.list(user("second", "worker")).isEmpty());
        }
    }

    @Test void completionChecksRevisionThenLocksAllWorkerWritesAndSurvivesRestart() {
        try (Platform platform = fixture()) {
            Auth.User leader = user("first", "worker");
            platform.datasets.claim(leader, "dataset", "group-a");
            platform.db.transaction(connection -> {
                try (Statement sql = connection.createStatement()) {
                    sql.execute("CREATE TABLE collab_projects(id TEXT PRIMARY KEY,dataset TEXT,fingerprint TEXT,revision INTEGER)");
                    sql.execute("INSERT INTO collab_projects VALUES('project','dataset','fingerprint',3)");
                }
                return null;
            });
            HttpResponseException omitted = assertThrows(HttpResponseException.class, () -> platform.datasets.complete(leader, "dataset", null));
            assertEquals(400, omitted.getStatus());
            HttpResponseException negative = assertThrows(HttpResponseException.class, () -> platform.datasets.complete(leader, "dataset", -1L));
            assertEquals(400, negative.getStatus());
            assertThrows(HttpResponseException.class, () -> platform.datasets.complete(leader, "dataset", 2L));
            assertEquals("in_progress", platform.dataset("dataset").get("status"));
            assertEquals("completed", platform.datasets.complete(leader, "dataset", 3L).get("status"));
            assertThrows(HttpResponseException.class, () -> platform.requireWrite(leader, "dataset"));
            assertDoesNotThrow(() -> platform.requireRead(leader, "dataset"));
            assertEquals("completed", platform.datasets.complete(leader, "dataset", 3L).get("status"));
        }
        try (Platform reopened = new Platform(temporary.resolve("state"), temporary.resolve("data"))) {
            assertEquals("completed", reopened.dataset("dataset").get("status"));
            assertEquals(3L, reopened.dataset("dataset").get("revision"));
        }
    }

    @Test void transactionRollbackCoversNestedPlatformCalls() {
        try (Platform platform = fixture()) {
            assertThrows(IllegalArgumentException.class, () -> platform.db.transaction(connection -> {
                platform.datasets.claim(user("first", "worker"), "dataset", "group-a");
                throw new IllegalArgumentException("rollback");
            }));
            assertEquals("unassigned", platform.dataset("dataset").get("status"));
            assertNull(platform.dataset("dataset").get("groupId"));
        }
    }

    private static int tryClaim(Platform platform, Auth.User user, String group) {
        try { platform.datasets.claim(user, "dataset", group); return 200; }
        catch (HttpResponseException error) { return error.getStatus(); }
    }

    private Platform fixture() {
        Platform platform = new Platform(temporary.resolve("state"), temporary.resolve("data"));
        platform.db.transaction(connection -> {
            for (Auth.User user : List.of(user("owner", "dispatcher"), user("other-owner", "dispatcher"), user("first", "worker"), user("second", "worker"))) {
                try (PreparedStatement insert = connection.prepareStatement("INSERT INTO users VALUES(?,?,?,?,?,?,?,?)")) {
                    insert.setString(1, user.id()); insert.setString(2, user.username()); insert.setString(3, user.name()); insert.setString(4, user.role());
                    insert.setBytes(5, new byte[32]); insert.setBytes(6, new byte[24]); insert.setInt(7, 600000); insert.setLong(8, 1); insert.executeUpdate();
                }
            }
            try (Statement sql = connection.createStatement()) {
                sql.execute("INSERT INTO groups VALUES('group-a','Alpha','AABBCCDDEEFF','first',1)");
                sql.execute("INSERT INTO groups VALUES('group-b','Beta','001122334455','second',1)");
                sql.execute("INSERT INTO group_members VALUES('group-a','first',1)");
                sql.execute("INSERT INTO group_members VALUES('group-b','second',1)");
                sql.execute("INSERT INTO datasets(id,owner_id,name,filename,size,fingerprint,format,created_at) VALUES('dataset','owner','test.nii','test.nii',368,'fingerprint','NIfTI',1)");
            }
            return null;
        });
        return platform;
    }

    private static Auth.User user(String id, String role) { return new Auth.User(id, id, id, role); }
}
