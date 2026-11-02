package io.deepmark;

import io.javalin.http.Context;
import io.javalin.http.ForbiddenResponse;
import jakarta.servlet.http.HttpServletRequest;
import org.junit.jupiter.api.Test;
import java.lang.reflect.Proxy;
import java.security.KeyPairGenerator;
import java.time.Clock;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;

class HttpTransportTest {
    @Test void httpOptInChangesTransportOnlyAndRetainsOriginAndMutationChecks() throws Exception {
        var generator=KeyPairGenerator.getInstance("RSA");generator.initialize(2048);var keys=generator.generateKeyPair();
        var strict=new Auth(null,Clock.systemUTC(),keys,false);
        var http=new Auth(null,Clock.systemUTC(),keys,true);
        Context valid=context(Map.of("Origin","http://192.168.43.24:8080","Sec-Fetch-Site","same-origin","X-Deepmark-Request","1"));
        assertThrows(ForbiddenResponse.class,()->strict.requireSecureTransport(valid));
        assertDoesNotThrow(()->http.requireSecureTransport(valid));
        assertDoesNotThrow(()->http.checkMutation(valid));
        assertDoesNotThrow(()->http.checkWebSocket(valid));
        assertThrows(ForbiddenResponse.class,()->http.checkMutation(context(Map.of("Origin","http://192.168.43.24:8080"))));
        Context foreign=context(Map.of("Origin","http://other.invalid","X-Deepmark-Request","1"));
        assertThrows(ForbiddenResponse.class,()->http.checkMutation(foreign));
        assertThrows(ForbiddenResponse.class,()->http.checkWebSocket(foreign));
    }
    private static Context context(Map<String,String> headers) {
        var request=(HttpServletRequest)Proxy.newProxyInstance(HttpTransportTest.class.getClassLoader(),new Class<?>[]{HttpServletRequest.class},(proxy,method,args)->{
            if(method.getName().equals("getRemoteAddr"))return "192.168.43.55";
            throw new UnsupportedOperationException(method.getName());
        });
        return (Context)Proxy.newProxyInstance(HttpTransportTest.class.getClassLoader(),new Class<?>[]{Context.class},(proxy,method,args)->switch(method.getName()){
            case "scheme" -> "http";
            case "host" -> "192.168.43.24:8080";
            case "req" -> request;
            case "header" -> headers.get((String)args[0]);
            default -> throw new UnsupportedOperationException(method.getName());
        });
    }
}
