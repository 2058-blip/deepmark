package io.deepmark;

import io.javalin.Javalin;
import io.javalin.json.JavalinJackson;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.Random;
import static org.junit.jupiter.api.Assertions.*;

class DatasetDownloadTest {
    @TempDir Path temporary;

    @Test void compressedSourceAndRangesStayByteExactWhenBrowserAcceptsHttpGzip() throws Exception {
        Path data = temporary.resolve("data");
        byte[] raw = new byte[352 + 64 * 64 * 8 * 2];
        new Random(173).nextBytes(raw);
        Arrays.fill(raw, 0, 352, (byte) 0);
        ByteBuffer header = ByteBuffer.wrap(raw).order(ByteOrder.LITTLE_ENDIAN);
        header.putInt(0, 348); header.putShort(40, (short) 3);
        for (int axis = 0; axis < 3; axis++) {
            header.putShort(42 + 2 * axis, (short) (axis == 2 ? 8 : 64));
            header.putFloat(80 + 4 * axis, 1);
        }
        header.putShort(70, (short) 4); header.putShort(72, (short) 16);
        header.putFloat(108, 352); header.putFloat(112, 1);
        raw[344] = 'n'; raw[345] = '+'; raw[346] = '1';
        byte[] source = Nifti.gzip(raw);
        assertTrue(source.length > 32000, "Exercise streaming an incompressible compressed image.");
        String token = "a".repeat(43), tokenHash = digest(token.getBytes(StandardCharsets.UTF_8));
        try (Platform platform = new Platform(temporary.resolve("state"), data)) {
            Files.write(data.resolve("source.nii.gz"), source);
            platform.db.transaction(connection -> {
                try (var statement = connection.prepareStatement("INSERT INTO users VALUES(?,?,?,?,?,?,?,?)")) {
                    statement.setString(1, "owner"); statement.setString(2, "download-test");
                    statement.setString(3, "Download test"); statement.setString(4, "dispatcher");
                    statement.setBytes(5, new byte[32]); statement.setBytes(6, new byte[24]);
                    statement.setInt(7, 600000); statement.setLong(8, System.currentTimeMillis()); statement.executeUpdate();
                }
                try (var statement = connection.prepareStatement("INSERT INTO sessions VALUES(?,?,?)")) {
                    statement.setString(1, tokenHash); statement.setString(2, "owner");
                    statement.setLong(3, System.currentTimeMillis() + 60000); statement.executeUpdate();
                }
                try (var statement = connection.prepareStatement("INSERT INTO datasets(id,owner_id,name,filename,size,fingerprint,format,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)")) {
                    statement.setString(1, "download-test"); statement.setString(2, "owner");
                    statement.setString(3, "source.nii.gz"); statement.setString(4, "source.nii.gz");
                    statement.setLong(5, source.length); statement.setString(6, digest(source));
                    statement.setString(7, "NIfTI · gzip"); statement.setString(8, "unassigned");
                    statement.setLong(9, System.currentTimeMillis()); statement.executeUpdate();
                }
                return null;
            });
            Javalin app = Javalin.create(config -> {
                config.showJavalinBanner = false;
                config.jsonMapper(new JavalinJackson(Platform.JSON, false));
            });
            platform.install(app); app.start("127.0.0.1", 0);
            try {
                HttpClient client = HttpClient.newHttpClient();
                URI url = URI.create("http://127.0.0.1:" + app.port() + "/api/datasets/download-test/download");
                var full = client.send(request(url, token).GET().build(), HttpResponse.BodyHandlers.ofByteArray());
                assertEquals(200, full.statusCode());
                assertTrue(full.headers().firstValue("Content-Encoding").isEmpty());
                assertEquals(source.length, full.headers().firstValueAsLong("Content-Length").orElseThrow());
                assertArrayEquals(source, full.body());
                var range = client.send(request(url, token).header("Range", "bytes=123-18123").GET().build(), HttpResponse.BodyHandlers.ofByteArray());
                assertEquals(206, range.statusCode());
                assertTrue(range.headers().firstValue("Content-Encoding").isEmpty());
                assertEquals("bytes 123-18123/" + source.length, range.headers().firstValue("Content-Range").orElseThrow());
                assertArrayEquals(Arrays.copyOfRange(source, 123, 18124), range.body());
                var head = client.send(request(url, token).method("HEAD", HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.ofByteArray());
                assertEquals(200, head.statusCode()); assertEquals(0, head.body().length);
                assertEquals(source.length, head.headers().firstValueAsLong("Content-Length").orElseThrow());
            } finally { app.stop(); }
        }
    }

    private static HttpRequest.Builder request(URI url, String token) {
        return HttpRequest.newBuilder(url).timeout(Duration.ofSeconds(10))
            .header("Accept-Encoding", "gzip").header("Cookie", "deepmark_session=" + token);
    }
    private static String digest(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }
}
