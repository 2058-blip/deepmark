package io.deepmark;

import com.fasterxml.jackson.core.StreamReadConstraints;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.javalin.Javalin;
import io.javalin.http.HttpResponseException;
import io.javalin.http.staticfiles.Location;
import io.javalin.json.JavalinJackson;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

/** The production HTTP and WebSocket process. Node.js is only a build tool. */
public final class Main {
    private static String env(String key, String fallback) {
        String value = System.getenv(key);
        return value == null || value.isBlank() ? fallback : value;
    }

    public static void main(String[] args) throws Exception {
        Path state = Path.of(env("STATE_DIR", "server-data/platform")).toAbsolutePath();
        Path datasets = Path.of(env("DATASET_DIR", "server-data/datasets")).toAbsolutePath();
        Path dist = Path.of(env("DIST_DIR", "dist")).toAbsolutePath();
        Files.createDirectories(state);
        Files.createDirectories(datasets);
        ObjectMapper mapper = Platform.JSON;
        mapper.getFactory().setStreamReadConstraints(StreamReadConstraints.builder()
            .maxStringLength(48 * 1024 * 1024).build());
        Platform platform = new Platform(state, datasets);
        Javalin app = Javalin.create(config -> {
            config.showJavalinBanner = false;
            config.http.maxRequestSize = 513L * 1024 * 1024;
            config.jsonMapper(new JavalinJackson(mapper, false));
            if (Files.isDirectory(dist)) {
                config.staticFiles.add(files -> {
                    files.hostedPath = "/";
                    files.directory = dist.toString();
                    files.location = Location.EXTERNAL;
                });
            }
        });
        app.before(ctx -> {
            ctx.header("X-Content-Type-Options", "nosniff");
            ctx.header("Referrer-Policy", "same-origin");
            ctx.header("X-Frame-Options", "DENY");
            ctx.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
            if (ctx.path().startsWith("/api/")) {
                ctx.header("Cache-Control", "no-store");
                if (!java.util.Set.of("GET", "HEAD", "OPTIONS").contains(ctx.method().name()))
                    platform.auth.checkMutation(ctx);
            }
        });
        app.exception(HttpResponseException.class, (error, ctx) ->
            ctx.status(error.getStatus()).json(Map.of("error", error.getMessage())));
        app.exception(Exception.class, (error, ctx) -> {
            System.err.println("Request failed: " + error.getClass().getSimpleName());
            ctx.status(500).json(Map.of("error", "服务器暂时无法完成请求。"));
        });
        app.error(404, ctx -> ctx.json(Map.of("error", "接口或文件不存在。")));
        app.get("/api/health", ctx -> ctx.json(Map.of("status", "ok", "backend", "java")));
        platform.install(app);
        Collaboration collaboration = new Collaboration(platform);
        collaboration.install(app);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            app.stop();
            platform.db.close();
        }, "deepmark-shutdown"));
        app.start(env("HOST", "127.0.0.1"), Integer.parseInt(env("PORT", "8787")));
    }
}
