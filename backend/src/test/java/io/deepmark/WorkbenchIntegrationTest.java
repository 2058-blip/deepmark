package io.deepmark;
import com.fasterxml.jackson.databind.JsonNode;
import io.javalin.Javalin;
import io.javalin.http.HttpResponseException;
import io.javalin.json.JavalinJackson;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.*;
import java.nio.file.*;
import java.net.*;
import java.net.http.*;
import java.security.MessageDigest;
import java.sql.PreparedStatement;
import java.util.*;
import java.util.concurrent.*;
import static org.junit.jupiter.api.Assertions.*;

class WorkbenchIntegrationTest {
    @TempDir Path temporary;
    final Auth.User a=new Auth.User("a","a","作者A","worker"),b=new Auth.User("b","b","作者B","worker");
    String json(Object value)throws Exception{return Platform.JSON.writeValueAsString(value);}
    static String hash(byte[] bytes)throws Exception{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));}
    void exec(Platform p,String sql,Object... values){p.db.transaction(c->{try(PreparedStatement q=c.prepareStatement(sql)){for(int i=0;i<values.length;i++)q.setObject(i+1,values[i]);q.executeUpdate();}return null;});}
    Platform fixture()throws Exception{
        Platform p=new Platform(temporary.resolve("state"),temporary.resolve("datasets"));
        for(String id:List.of("owner","a","b","outside")){
            exec(p,"INSERT INTO users VALUES(?,?,?,?,?,?,?,?)",id,id,id,id.equals("owner")?"dispatcher":"worker",new byte[32],new byte[24],1,System.currentTimeMillis());
            exec(p,"INSERT INTO sessions VALUES(?,?,?)",hash(id.repeat(43).substring(0,43).getBytes(java.nio.charset.StandardCharsets.UTF_8)),id,System.currentTimeMillis()+3600000);
        }
        exec(p,"INSERT INTO groups VALUES('g','Team','CODE','a',1)");
        exec(p,"INSERT INTO group_members VALUES('g','a',1)");exec(p,"INSERT INTO group_members VALUES('g','b',1)");
        byte[] bytes=new byte[352+32*2];ByteBuffer h=ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
        h.putInt(0,348).putShort(40,(short)3);for(int i=0;i<3;i++){h.putShort(42+2*i,(short)(i==2?2:4));h.putFloat(80+4*i,1);}
        h.putShort(70,(short)4).putShort(72,(short)16).putFloat(108,352).putFloat(112,1);h.put(123,(byte)2);h.put(344,(byte)'n').put(345,(byte)'+').put(346,(byte)'1');
        Files.write(temporary.resolve("datasets/ct.nii"),bytes);
        exec(p,"INSERT INTO datasets(id,owner_id,name,filename,size,fingerprint,format,status,created_at) VALUES('ct','owner','CT','ct.nii',?,?,'NIfTI','unassigned',1)",bytes.length,hash(bytes));
        p.datasets.claim(a,"ct","g");return p;
    }
    String token(String id){return id.repeat(43).substring(0,43);}
    static byte[] paint(int start,int length,int before,int after){return WorkbenchModel.encode(List.of(new WorkbenchModel.Run(start,length,before,after)));}
    @Test void platformPermissionIdempotencyHistoryOverlapAndRestartArePreserved()throws Exception{
        String id;
        try(Platform p=fixture()){
            String fingerprint=(String)p.dataset("ct").get("fingerprint");id=(String)p.workbenches.join(a,"ct",fingerprint).get("id");
            assertEquals(id,p.workbenches.join(b,"ct",fingerprint).get("id"));
            assertThrows(HttpResponseException.class,()->p.workbenches.join(new Auth.User("outside","outside","outside","worker"),"ct",fingerprint));
            p.workbenches.stage(a,id,"paint-a",0,"mask-1",paint(0,2,0,1));
            JsonNode request=Platform.JSON.readTree("{\"op\":\"paint-a\",\"baseRevision\":0,\"parts\":1,\"kind\":\"绘制Mask\",\"changes\":{}}");
            var first=p.workbenches.commit(a,id,request);assertEquals(1,((JsonNode)first.get("event")).path("revision").asInt());
            assertEquals(true,p.workbenches.commit(a,id,request).get("duplicate"));
            assertEquals(1L,p.dataset("ct").get("revision"));assertEquals(id,p.dataset("ct").get("projectId"));
            p.workbenches.stage(b,id,"erase-b",0,"mask-1",paint(0,2,1,0));
            var denied=p.workbenches.commit(b,id,Platform.JSON.readTree("{\"op\":\"erase-b\",\"baseRevision\":1,\"parts\":1,\"changes\":{},\"author\":\"a\"}"));
            assertEquals(2,denied.get("protectedCount"));assertEquals("b",((JsonNode)denied.get("event")).path("author").asText());
            var changes=Platform.JSON.readTree("{\"upserts\":{\"masks\":[{\"id\":\"second\",\"name\":\"Second\",\"color\":\"#ffffff\",\"threshold\":null,\"revision\":0}]}}");
            p.workbenches.stage(b,id,"second-b",0,"second",paint(1,2,0,1));
            var create=Platform.JSON.createObjectNode();create.put("op","second-b").put("baseRevision",2).put("parts",1);create.set("changes",changes);
            p.workbenches.commit(b,id,create);
            JsonNode current=Platform.JSON.valueToTree(p.workbenches.snapshot(a,id,null));
            assertEquals(2,current.path("manifest").path("masks").size());assertEquals(0,current.path("manifest").path("masks").get(1).path("revision").asInt(),"new native Masks start at version zero");
            assertEquals(1,Platform.JSON.valueToTree(p.workbenches.snapshot(a,id,1L)).path("manifest").path("masks").size());
            assertEquals(3,((List<?>)p.workbenches.events(a,id,0).get("events")).size());
            assertThrows(HttpResponseException.class,()->p.workbenches.stage(new Auth.User("owner","owner","owner","dispatcher"),id,"bad",0,"mask-1",paint(2,1,0,1)));
        }
        try(Platform p=new Platform(temporary.resolve("state"),temporary.resolve("datasets"))){
            JsonNode restored=Platform.JSON.valueToTree(p.workbenches.snapshot(b,id,null));assertEquals(3,restored.path("revision").asInt());assertEquals(2,restored.path("claims").size());
            assertEquals(2,((List<?>)p.workbenches.provenance(a,id,1).get("annotations")).size());
            p.datasets.complete(a,"ct",3L);
            assertFalse((Boolean)p.workbenches.snapshot(b,id,null).get("canWrite"));
            assertThrows(HttpResponseException.class,()->p.workbenches.stage(b,id,"after-completion",0,"mask-1",paint(3,1,0,1)));
        }
    }
    @Test void realHttpAndWebSocketUseExistingSessionsAndCsrfGuards()throws Exception{
        try(Platform p=fixture()){
            Javalin app=Javalin.create(config->{config.showJavalinBanner=false;config.jsonMapper(new JavalinJackson(Platform.JSON,false));});
            try{
            app.exception(HttpResponseException.class,(error,ctx)->ctx.status(error.getStatus()).json(Map.of("error",error.getMessage())));
            p.install(app);app.start("127.0.0.1",0);
            String base="http://127.0.0.1:"+app.port(),fingerprint=(String)p.dataset("ct").get("fingerprint");
            HttpClient client=HttpClient.newHttpClient();
            var joined=call(client,base,"a","POST",WorkbenchCollaboration.BASE,json(Map.of("datasetId","ct","fingerprint",fingerprint)).getBytes(),Map.of());
            assertEquals(200,joined.statusCode());String id=Platform.JSON.readTree(joined.body()).path("id").asText();
            assertEquals(401,call(client,base,"","GET",WorkbenchCollaboration.BASE+"/"+id,null,Map.of()).statusCode());
            assertEquals(403,call(client,base,"outside","GET",WorkbenchCollaboration.BASE+"/"+id,null,Map.of()).statusCode());
            BlockingQueue<String> messages=new LinkedBlockingQueue<>();
            var socket=client.newWebSocketBuilder().header("Cookie",Auth.COOKIE_NAME+"="+token("b")).header("Origin",base)
                .buildAsync(URI.create(base.replace("http:","ws:")+WorkbenchCollaboration.SOCKET+"?project="+id+"&author=b"),new WebSocket.Listener(){
                    final StringBuilder text=new StringBuilder();
                    @Override public void onOpen(WebSocket ws){ws.request(1);}
                    @Override public CompletionStage<?> onText(WebSocket ws,CharSequence data,boolean last){text.append(data);if(last){messages.add(text.toString());text.setLength(0);}ws.request(1);return CompletableFuture.completedFuture(null);}
                }).get(5,TimeUnit.SECONDS);
            String path=WorkbenchCollaboration.BASE+"/"+id+"/operations/http-op/parts/0";
            assertEquals(401,call(client,base,"b","PUT",path,paint(0,1,0,1),Map.of("X-Mask-Id","mask-1","X-Workbench-Author","a")).statusCode());
            assertEquals(200,call(client,base,"a","PUT",path,paint(0,1,0,1),Map.of("X-Mask-Id","mask-1")).statusCode());
            var result=call(client,base,"a","POST",WorkbenchCollaboration.BASE+"/"+id+"/operations","{\"op\":\"http-op\",\"baseRevision\":0,\"parts\":1,\"changes\":{}}".getBytes(),Map.of());
            assertEquals(200,result.statusCode());boolean delivered=false;long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
            while(System.nanoTime()<deadline){String message=messages.poll(500,TimeUnit.MILLISECONDS);if(message!=null&&Platform.JSON.readTree(message).path("type").asText().equals("committed")){delivered=true;break;}}
            assertTrue(delivered,"other session must receive result revision notification");
            var mask=call(client,base,"b","GET",WorkbenchCollaboration.BASE+"/"+id+"/mask?mask=mask-1",null,Map.of());assertEquals(200,mask.statusCode());
            ByteBuffer stream=ByteBuffer.wrap(mask.body()).order(ByteOrder.LITTLE_ENDIAN);int size=stream.getInt();byte[] packet=new byte[size];stream.get(packet);assertEquals(1,WorkbenchModel.decode(packet,32).get(0).after());assertEquals(0,stream.getInt());
            var forged=HttpRequest.newBuilder(URI.create(base+WorkbenchCollaboration.BASE+"/"+id+"/operations")).header("Cookie",Auth.COOKIE_NAME+"="+token("a")).header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString("{}")).build();
            assertEquals(403,client.send(forged,HttpResponse.BodyHandlers.ofByteArray()).statusCode());
            socket.sendClose(WebSocket.NORMAL_CLOSURE,"done").join();
            }finally{app.stop();}
        }
    }
    @Test void legacyMigrationPreservesAgreementsParallelLabelsAndSeedHistoryAcrossRestart()throws Exception{
        String nativeId;
        try(Platform p=fixture()){
            Collaboration old=new Collaboration(p);Javalin app=Javalin.create(config->{config.showJavalinBanner=false;config.jsonMapper(new JavalinJackson(Platform.JSON,false));});
            try{
                app.exception(HttpResponseException.class,(error,ctx)->ctx.status(error.getStatus()).json(Map.of("error",error.getMessage())));p.install(app);old.install(app);app.start("127.0.0.1",0);
                String base="http://127.0.0.1:"+app.port(),fingerprint=(String)p.dataset("ct").get("fingerprint");HttpClient client=HttpClient.newHttpClient();
                var joined=call(client,base,"a","POST","/api/collaboration/projects",json(Map.of("datasetId","ct","fingerprint",fingerprint)).getBytes(),Map.of());assertEquals(200,joined.statusCode());
                String legacy=Platform.JSON.readTree(joined.body()).path("id").asText(),route="/api/collaboration/projects/"+legacy;
                String first=Collaboration.encodePatch(List.of(new int[]{0,0,1},new int[]{1,0,1}));
                assertEquals(200,call(client,base,"a","POST",route+"/operations",json(Map.of("op","old-a","baseRevision",0,"patch",first)).getBytes(),Map.of()).statusCode());
                assertEquals(200,call(client,base,"b","POST",route+"/operations",json(Map.of("op","old-agree","baseRevision",1,"patch",Collaboration.encodePatch(List.of(new int[]{0,1,1})))).getBytes(),Map.of()).statusCode());
                var label=call(client,base,"b","POST",route+"/labels",json(Map.of("op","new-label","name","Parallel","color","#ffffff")).getBytes(),Map.of());assertEquals(200,label.statusCode());
                int number=Platform.JSON.readTree(label.body()).path("label").path("id").asInt();
                assertEquals(200,call(client,base,"b","POST",route+"/operations",json(Map.of("op","old-parallel","baseRevision",3,"patch",Collaboration.encodePatch(List.of(new int[]{1,1,number})))).getBytes(),Map.of()).statusCode());
                var nativeState=p.workbenches.join(a,"ct",fingerprint);nativeId=(String)nativeState.get("id");
                JsonNode state=Platform.JSON.valueToTree(nativeState);assertEquals(4,state.path("manifest").path("legacySource").path("revision").asInt());assertEquals(2,state.path("manifest").path("masks").size());
                assertEquals(2,((List<?>)p.workbenches.provenance(a,nativeId,0).get("annotations")).size(),"same-label authorship agreements survive");
                assertTrue(((List<?>)p.workbenches.provenance(a,nativeId,1).get("annotations")).size()>=2,"both parallel labels survive");
                assertFalse(Platform.JSON.readTree(call(client,base,"a","GET",route,null,Map.of()).body()).path("canWrite").asBoolean());
                assertEquals(423,call(client,base,"a","POST",route+"/operations",json(Map.of("op","old-write","baseRevision",4,"patch",Collaboration.encodePatch(List.of(new int[]{2,0,1})))).getBytes(),Map.of()).statusCode());
                assertEquals(4,((List<?>)p.workbenches.history(a,nativeId).get("legacy")).size());
                assertEquals(0,Platform.JSON.valueToTree(p.workbenches.legacySnapshot(a,nativeId,0)).path("revision").asInt());
                JsonNode legacyAuthors=Platform.JSON.valueToTree(p.workbenches.legacySnapshot(a,nativeId,4)).path("claims");
                assertEquals(3,legacyAuthors.size(),"historical hover retains all authors, including same-Mask agreements");
                assertTrue(legacyAuthors.findValuesAsText("author").containsAll(List.of("a","b")));
                p.workbenches.stage(a,nativeId,"native-withdraw",0,"legacy-1",paint(0,1,1,0));p.workbenches.commit(a,nativeId,Platform.JSON.readTree("{\"op\":\"native-withdraw\",\"baseRevision\":0,\"parts\":1,\"changes\":{}}"));
                assertEquals(1,((List<?>)p.workbenches.provenance(a,nativeId,0).get("annotations")).size());
            }finally{app.stop();}
        }
        try(Platform p=new Platform(temporary.resolve("state"),temporary.resolve("datasets"))){
            assertEquals(1,((List<?>)p.workbenches.provenance(a,nativeId,0).get("annotations")).size());
            JsonNode seed=Platform.JSON.valueToTree(p.workbenches.snapshot(a,nativeId,0L));assertEquals(0,seed.path("revision").asInt());assertEquals(4,seed.path("manifest").path("legacySource").path("revision").asInt());
            assertEquals(3,seed.path("claims").size(),"seed keeps two authors on first Mask and the alternative label");
        }
    }
    private HttpResponse<byte[]> call(HttpClient client,String base,String user,String method,String path,byte[] body,Map<String,String> extra)throws Exception{
        var request=HttpRequest.newBuilder(URI.create(base+path)).header("Origin",base);
        if(!user.isEmpty())request.header("Cookie",Auth.COOKIE_NAME+"="+token(user));
        if(!method.equals("GET"))request.header("X-Deepmark-Request","1");
        if(method.equals("POST"))request.header("Content-Type","application/json");
        for(var header:extra.entrySet())request.header(header.getKey(),header.getValue());
        request.method(method,body==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofByteArray(body));
        return client.send(request.build(),HttpResponse.BodyHandlers.ofByteArray());
    }
}
