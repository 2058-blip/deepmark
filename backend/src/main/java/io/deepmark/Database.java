package io.deepmark;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;

/** A shared lock serializes platform claims and collaborative revisions in one SQLite transaction. */
public final class Database implements AutoCloseable {
    @FunctionalInterface public interface SqlFunction<T> { T run(Connection connection) throws Exception; }
    private final Connection connection;

    public Database(Path file) {
        this(file.toAbsolutePath().toString());
    }

    public Database(String file) {
        try {
            if (!file.equals(":memory:")) {
                Path parent = Path.of(file).toAbsolutePath().getParent();
                if (parent != null) Files.createDirectories(parent);
            }
            connection = DriverManager.getConnection("jdbc:sqlite:" + file);
            try (Statement sql = connection.createStatement()) {
                sql.execute("PRAGMA foreign_keys=ON");
                sql.execute("PRAGMA busy_timeout=5000");
                sql.execute("PRAGMA journal_mode=WAL");
                sql.execute("CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,name TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('dispatcher','worker')),password_hash BLOB NOT NULL,password_salt BLOB NOT NULL,password_iterations INTEGER NOT NULL,created_at INTEGER NOT NULL)");
                sql.execute("CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL)");
                sql.execute("CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at)");
                sql.execute("CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY,name TEXT NOT NULL,code TEXT NOT NULL UNIQUE,leader_id TEXT NOT NULL REFERENCES users(id),created_at INTEGER NOT NULL)");
                sql.execute("CREATE TABLE IF NOT EXISTS group_members(group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),joined_at INTEGER NOT NULL,PRIMARY KEY(group_id,user_id))");
                sql.execute("CREATE INDEX IF NOT EXISTS group_members_user ON group_members(user_id)");
                sql.execute("CREATE TABLE IF NOT EXISTS datasets(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,filename TEXT NOT NULL UNIQUE,size INTEGER NOT NULL,fingerprint TEXT NOT NULL,format TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'unassigned' CHECK(status IN ('unassigned','in_progress','completed')),group_id TEXT REFERENCES groups(id),created_at INTEGER NOT NULL,claimed_at INTEGER,completed_at INTEGER,claimed_by TEXT REFERENCES users(id))");
                sql.execute("CREATE INDEX IF NOT EXISTS datasets_owner ON datasets(owner_id,created_at)");
                sql.execute("CREATE INDEX IF NOT EXISTS datasets_group ON datasets(group_id,status)");
            }
        } catch (Exception error) { throw new IllegalStateException("Cannot open platform database", error); }
    }

    public synchronized <T> T read(SqlFunction<T> operation) {
        try { return operation.run(connection); }
        catch (RuntimeException error) { throw error; }
        catch (Exception error) { throw new IllegalStateException("Database operation failed", error); }
    }

    public synchronized <T> T transaction(SqlFunction<T> operation) {
        try {
            if (!connection.getAutoCommit()) return read(operation);
            connection.setAutoCommit(false);
            try {
                T result = operation.run(connection);
                connection.commit();
                return result;
            } catch (Exception error) {
                try { connection.rollback(); } catch (SQLException rollback) { error.addSuppressed(rollback); }
                if (error instanceof RuntimeException runtime) throw runtime;
                throw new IllegalStateException("Database transaction failed", error);
            } finally { connection.setAutoCommit(true); }
        } catch (SQLException error) { throw new IllegalStateException("Database transaction failed", error); }
    }

    @Override public synchronized void close() {
        try { connection.close(); } catch (SQLException error) { throw new IllegalStateException(error); }
    }
}
