package io.deepmark;

import com.fasterxml.jackson.databind.JsonNode;
import io.javalin.Javalin;
import io.javalin.http.HttpResponseException;
import io.javalin.json.JavalinJackson;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.sql.PreparedStatement;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.function.Predicate;
import java.util.zip.ZipInputStream;
import java.io.ByteArrayInputStream;
import static org.junit.jupiter.api.Assertions.*;

class CollaborationIdentityTest {
    @TempDir Path temporary;
    private static final String BASE="/api/collaboration";

    @Test void sameLabelClaimsSupportImmediatePersonalWithdrawalAndRemainRevisionAccurate() throws Exception {
        try(Fixture f=fixture()){
            String project=f.join("worker-a").path("id").asText();
            JsonNode a=f.post(project,"operations","worker-a",Map.of("op","claim-a","baseRevision",0,"patch",Collaboration.encodePatch(List.of(new int[]{0,0,1}))));
            assertTrue(a.path("delta").path("claims").isEmpty());
            JsonNode b=f.post(project,"operations","worker-b",Map.of("op","claim-b","baseRevision",1,"patch",Collaboration.encodePatch(List.of(new int[]{0,1,1}))));
            assertEquals(List.of("worker-a","worker-b"),Platform.JSON.convertValue(b.path("delta").path("claims").get(0).get(1),List.class));
            JsonNode shared=f.json(f.request("GET",BASE+"/projects/"+project,"worker-b",null));
            assertEquals(b.path("delta").path("claims"),shared.path("claims"));assertTrue(shared.path("regions").isEmpty());
            JsonNode third=f.post(project,"operations","offline-member",Map.of("op","claim-third","baseRevision",2,"patch",Collaboration.encodePatch(List.of(new int[]{0,1,1}))));
            assertEquals(3,third.path("delta").path("claims").get(0).get(1).size());
            JsonNode withdraw=f.post(project,"operations","worker-a",Map.of("op","withdraw-a","baseRevision",3,"patch",Collaboration.encodePatch(List.of(new int[]{0,1,0}))));
            assertEquals("offline-member",withdraw.path("delta").path("claims").get(0).get(1).get(0).asText(),"The first claim author is the canonical primary after transfer");
            JsonNode remaining=f.json(f.request("GET",BASE+"/projects/"+project,"worker-b",null));assertEquals(1,Nifti.gunzipU16(java.util.Base64.getDecoder().decode(remaining.path("mask").asText()))[0]);
            JsonNode old=f.json(f.request("GET",BASE+"/projects/"+project+"?revision=2","worker-b",null));assertEquals(shared.path("claims"),old.path("claims"));
            f.post(project,"operations","worker-b",Map.of("op","withdraw-b","baseRevision",4,"patch",Collaboration.encodePatch(List.of(new int[]{0,1,0}))));
            f.post(project,"operations","offline-member",Map.of("op","withdraw-third","baseRevision",5,"patch",Collaboration.encodePatch(List.of(new int[]{0,1,0}))));
            JsonNode empty=f.json(f.request("GET",BASE+"/projects/"+project,"worker-b",null));assertTrue(empty.path("claims").isEmpty());assertEquals(0,Nifti.gunzipU16(java.util.Base64.getDecoder().decode(empty.path("mask").asText()))[0]);
        }
    }

    @Test void withdrawingHiddenAgreementDoesNotResurrectItAndParallelRegionsDoNotDuplicateClaims() throws Exception {
        try(Fixture f=fixture()){
            String project=f.join("worker-a").path("id").asText();
            f.post(project,"operations","worker-a",Map.of("op","hidden-a","baseRevision",0,"patch",Collaboration.encodePatch(List.of(new int[]{0,0,1},new int[]{1,0,1}))));
            f.post(project,"operations","worker-b",Map.of("op","hidden-b","baseRevision",1,"patch",Collaboration.encodePatch(List.of(new int[]{0,1,1},new int[]{1,1,1}))));
            JsonNode withdrawn=f.post(project,"operations","worker-b",Map.of("op","hidden-withdraw-b","baseRevision",2,"patch",Collaboration.encodePatch(List.of(new int[]{0,1,0}))));
            assertEquals(1,withdrawn.path("delta").path("claims").size());assertEquals(1,withdrawn.path("delta").path("claims").get(0).get(0).asInt());
            f.post(project,"operations","worker-a",Map.of("op","hidden-withdraw-a","baseRevision",3,"patch",Collaboration.encodePatch(List.of(new int[]{0,1,0}))));
            JsonNode state=f.json(f.request("GET",BASE+"/projects/"+project,"worker-a",null));assertEquals(0,Nifti.gunzipU16(java.util.Base64.getDecoder().decode(state.path("mask").asText()))[0]);
            JsonNode label=f.post(project,"labels","worker-a",Map.of("name","other","color","#123456"));
            int id=label.path("label").path("id").asInt();
            JsonNode parallel=f.post(project,"operations","worker-a",Map.of("op","hidden-parallel-a","baseRevision",5,"patch",Collaboration.encodePatch(List.of(new int[]{1,1,id}))));
            assertEquals(1,parallel.path("delta").path("regions").size());assertTrue(parallel.path("delta").path("claims").isEmpty());
        }
    }

    @Test void cachedGeometryRechecksFileIdentityAndMetadataEndpointKeepsAccessChecks() throws Exception {
        try(Fixture f=fixture()){
            var first=f.platform.datasets.geometry("dataset");
            assertSame(first,f.platform.datasets.geometry("dataset"));
            assertEquals(200,f.request("GET","/api/datasets/dataset","worker-a",null).statusCode());
            assertEquals(403,f.request("GET","/api/datasets/dataset","outsider",null).statusCode());
            assertEquals(401,f.request("GET","/api/datasets/dataset",null,null).statusCode());
            Path file=f.platform.datasets.resolve("dataset").path();
            byte[] changed=source();changed[352]=1;Files.write(file,changed);
            Files.setLastModifiedTime(file,java.nio.file.attribute.FileTime.fromMillis(System.currentTimeMillis()+5000));
            assertThrows(HttpResponseException.class,()->f.platform.datasets.geometry("dataset"));
        }
    }

    @Test void backgroundCheckpointPreservesLiveStateAndHistoricalReplay() throws Exception {
        try(Fixture f=fixture()){
            String project=f.join("worker-a").path("id").asText();
            for(int i=0;i<140;i++){
                String patch=Collaboration.encodePatch(List.of(new int[]{0,i%2,(i+1)%2}));
                JsonNode result=f.post(project,"operations","worker-a",Map.of("op","checkpoint-"+i,"baseRevision",i,"patch",patch));
                assertEquals(i+1,result.path("revision").asLong());
            }
            long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);long checkpoint;
            do{checkpoint=f.platform.db.read(c->{try(var s=c.createStatement();var r=s.executeQuery("SELECT MAX(revision) FROM collab_snapshots WHERE project='"+project+"'")){r.next();return r.getLong(1);}});if(checkpoint<128)Thread.sleep(10);}while(checkpoint<128&&System.nanoTime()<until);
            assertTrue(checkpoint>=128);
            for(long revision:List.of(0L,63L,128L,140L)){
                JsonNode state=f.json(f.request("GET",BASE+"/projects/"+project+"?revision="+revision,"worker-a",null));
                int[] mask=Nifti.gunzipU16(java.util.Base64.getDecoder().decode(state.path("mask").asText()));
                assertEquals(revision%2,mask[0],"Historical result must survive an asynchronous checkpoint");
            }
        }
    }

    @Test void onlinePresenceDeduplicatesTabsTracksDisconnectsAndRevokesAccess() throws Exception {
        try(Fixture f=fixture()){
            String project=f.join("worker-a").path("id").asText();
            assertEquals(0,f.presence(project,"worker-a").size());
            Listener first=new Listener(),secondTab=new Listener(),other=new Listener(),owner=new Listener();
            WebSocket a=f.socket(project,"worker-a",first),a2=f.socket(project,"worker-a",secondTab),b=f.socket(project,"worker-b",other),d=f.socket(project,"owner",owner);
            try{
                assertEquals(3,f.awaitMembers(project,3).size(),"Only connected people count, not all group members or tabs");
                JsonNode event=first.await(node->node.path("type").asText().equals("presence")&&node.path("members").size()==3);
                assertEquals(project,event.path("projectId").asText());
                assertTrue(members(event.path("members")).contains("owner:dispatcher"));
                assertTrue(members(event.path("members")).contains("worker-a:worker"));
                a.sendClose(WebSocket.NORMAL_CLOSURE,"close one tab").join();
                first.closed.await(5,TimeUnit.SECONDS);
                assertEquals(3,f.presence(project,"worker-b").size(),"Another tab keeps the same person online");
                a2.sendClose(WebSocket.NORMAL_CLOSURE,"close final tab").join();
                secondTab.closed.await(5,TimeUnit.SECONDS);
                assertEquals(2,f.awaitMembers(project,2).size());
                owner.await(node->node.path("type").asText().equals("presence")&&node.path("members").size()==2);
                assertEquals(403,f.request("GET",BASE+"/projects/"+project+"/presence","outsider",null).statusCode());
                assertEquals(401,f.request("GET",BASE+"/projects/"+project+"/presence",null,null).statusCode());
                f.platform.db.transaction(c->{try(PreparedStatement sql=c.prepareStatement("DELETE FROM group_members WHERE user_id=?")){sql.setString(1,"worker-b");sql.executeUpdate();}return null;});
                owner.await(node->node.path("type").asText().equals("presence")&&node.path("members").size()==1);
                assertTrue(other.closed.await(5,TimeUnit.SECONDS),"Idle connections are rechecked without edits or HTTP polling");
                assertEquals(1,f.presence(project,"owner").size());
                assertEquals(403,f.request("GET",BASE+"/projects/"+project+"/presence","worker-b",null).statusCode());
                // Expired or logged-out sessions do not remain visible as collaborators either.
                f.platform.db.transaction(c->{try(PreparedStatement sql=c.prepareStatement("DELETE FROM sessions WHERE user_id=?")){sql.setString(1,"owner");sql.executeUpdate();}return null;});
                assertTrue(owner.closed.await(8,TimeUnit.SECONDS));
                assertEquals(0,f.presence(project,"worker-a").size());
            }finally{a.abort();a2.abort();b.abort();d.abort();}
        }
    }

    @Test void labelCreatorsAreAuthenticatedImmutableDurableAndIncludedInHistoryAndExport() throws Exception {
        try(Fixture f=fixture()){
            JsonNode joined=f.join("worker-a");String project=joined.path("id").asText();
            JsonNode initial=joined.path("labels").get(0);
            assertEquals("worker-a",initial.path("createdBy").path("id").asText());
            assertFalse(initial.path("createdAt").asText().isBlank());
            JsonNode added=f.post(project,"labels","worker-b",Map.of("op","create-label","name","肺","color","#123456","createdBy",Map.of("id","worker-a","name","fake"),"createdAt","fake"));
            JsonNode label=added.path("label");int id=label.path("id").asInt();
            assertEquals("worker-b",label.path("createdBy").path("id").asText());
            assertEquals("worker-b name",label.path("createdBy").path("name").asText());
            assertNotEquals("fake",label.path("createdAt").asText());
            assertEquals(label,added.path("delta").path("labels").get(1));
            JsonNode changed=f.post(project,"labels","worker-a",Map.of("op","rename-label","id",id,"name","右肺","color","#abcdef","createdBy",Map.of("id","worker-a"),"createdAt","fake"));
            assertEquals(label.path("createdBy"),changed.path("label").path("createdBy"));
            assertEquals(label.path("createdAt"),changed.path("label").path("createdAt"));
            assertEquals(403,f.request("POST",BASE+"/projects/"+project+"/labels","owner",Map.of()).statusCode());
            JsonNode history=f.json(f.request("GET",BASE+"/projects/"+project+"/history","worker-a",null)).path("events");
            assertEquals("worker-a",history.get(0).path("author").asText());
            assertEquals("标签设置",history.get(0).path("kind").asText());
            assertEquals("worker-b",history.get(1).path("author").asText());
            assertEquals("新增标签",history.get(1).path("kind").asText());
            JsonNode old=f.json(f.request("GET",BASE+"/projects/"+project+"?revision=1","worker-a",null));
            assertEquals(label,old.path("labels").get(1));
            HttpResponse<byte[]> archive=f.client.send(f.build("GET",BASE+"/projects/"+project+"/export","worker-a",null),HttpResponse.BodyHandlers.ofByteArray());
            try(ZipInputStream zip=new ZipInputStream(new ByteArrayInputStream(archive.body()),StandardCharsets.UTF_8)){
                boolean found=false;for(var entry=zip.getNextEntry();entry!=null;entry=zip.getNextEntry())if(entry.getName().equals("labels.json")){JsonNode labels=Platform.JSON.readTree(zip.readAllBytes()).path("segments");assertEquals(label.path("createdBy"),labels.get(1).path("createdBy"));found=true;}
                assertTrue(found);
            }
            // A fresh authenticated read returns the metadata committed to SQLite.
            JsonNode latest=f.json(f.request("GET",BASE+"/projects/"+project,"worker-a",null));
            assertEquals(label.path("createdBy"),latest.path("labels").get(1).path("createdBy"));
            // Older projects have no trustworthy creator record. A rename must not invent one.
            f.platform.db.transaction(c->{try(PreparedStatement sql=c.prepareStatement("UPDATE collab_projects SET labels=? WHERE id=?")){sql.setString(1,"[{\"id\":1,\"name\":\"legacy\",\"color\":\"#123456\"}]");sql.setString(2,project);sql.executeUpdate();}return null;});
            JsonNode legacy=f.post(project,"labels","worker-a",Map.of("id",1,"name","legacy renamed"));
            assertFalse(legacy.path("label").has("createdBy"));
            assertFalse(legacy.path("label").has("createdAt"));
        }
    }

    private static List<String> members(JsonNode rows){List<String> result=new ArrayList<>();for(JsonNode row:rows)result.add(row.path("id").asText()+":"+row.path("role").asText());return result;}
    private Fixture fixture() throws Exception{return new Fixture(temporary.resolve(UUID.randomUUID().toString()));}
    private static byte[] source(){ByteBuffer b=ByteBuffer.allocate(368).order(ByteOrder.LITTLE_ENDIAN);b.putInt(0,348);b.putShort(40,(short)3);for(int a=0;a<3;a++){b.putShort(42+a*2,(short)2);b.putFloat(80+a*4,1);}b.putShort(70,(short)4);b.putShort(72,(short)16);b.putFloat(108,352);b.put(344,(byte)'n');b.put(345,(byte)'+');b.put(346,(byte)'1');return b.array();}
    private static String token(String user){return (user+"-".repeat(43)).substring(0,43);}
    private static String digest(String text)throws Exception{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));}

    private static final class Listener implements WebSocket.Listener{
        final BlockingQueue<JsonNode> messages=new LinkedBlockingQueue<>();final java.util.concurrent.CountDownLatch closed=new java.util.concurrent.CountDownLatch(1);final StringBuilder text=new StringBuilder();
        public void onOpen(WebSocket socket){socket.request(1);}
        public CompletionStage<?> onText(WebSocket socket,CharSequence part,boolean last){text.append(part);if(last){try{messages.add(Platform.JSON.readTree(text.toString()));}catch(Exception error){throw new IllegalArgumentException(error);}text.setLength(0);}socket.request(1);return null;}
        public CompletionStage<?> onClose(WebSocket socket,int code,String reason){closed.countDown();return null;}
        JsonNode await(Predicate<JsonNode> filter)throws Exception{long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(8);while(System.nanoTime()<until){JsonNode node=messages.poll(200,TimeUnit.MILLISECONDS);if(node!=null&&filter.test(node))return node;}fail("Expected WebSocket event was not received");return null;}
    }
    private static final class Fixture implements AutoCloseable{
        final Platform platform;final Javalin app;final HttpClient client=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();final String url,fingerprint;
        Fixture(Path directory)throws Exception{
            Path data=directory.resolve("data");Files.createDirectories(data);byte[] bytes=source();Files.write(data.resolve("test.nii"),bytes);fingerprint=Collaboration.sha256(bytes);platform=new Platform(directory.resolve("state"),data);
            platform.db.transaction(c->{
                for(String user:List.of("owner","worker-a","worker-b","outsider","offline-member")){
                    try(PreparedStatement sql=c.prepareStatement("INSERT INTO users VALUES(?,?,?,?,?,?,?,?)")){sql.setString(1,user);sql.setString(2,user);sql.setString(3,user+" name");sql.setString(4,user.equals("owner")?"dispatcher":"worker");sql.setBytes(5,new byte[32]);sql.setBytes(6,new byte[24]);sql.setInt(7,600000);sql.setLong(8,1);sql.executeUpdate();}
                    try(PreparedStatement sql=c.prepareStatement("INSERT INTO sessions VALUES(?,?,?)")){sql.setString(1,digest(token(user)));sql.setString(2,user);sql.setLong(3,System.currentTimeMillis()+60000);sql.executeUpdate();}
                }
                try(var sql=c.createStatement()){sql.execute("INSERT INTO groups VALUES('group','Group','AABBCCDDEEFF','worker-a',1)");for(String user:List.of("worker-a","worker-b","offline-member"))sql.execute("INSERT INTO group_members VALUES('group','"+user+"',1)");}
                try(PreparedStatement sql=c.prepareStatement("INSERT INTO datasets(id,owner_id,name,filename,size,fingerprint,format,status,group_id,created_at) VALUES('dataset','owner','test.nii','test.nii',368,?,'NIfTI','in_progress','group',1)")){sql.setString(1,fingerprint);sql.executeUpdate();}
                return null;
            });
            app=Javalin.create(config->{config.showJavalinBanner=false;config.jsonMapper(new JavalinJackson(Platform.JSON,false));});
            app.exception(HttpResponseException.class,(error,ctx)->ctx.status(error.getStatus()).json(Map.of("error",error.getMessage())));platform.install(app);new Collaboration(platform).install(app);app.start("127.0.0.1",0);url="http://127.0.0.1:"+app.port();
        }
        HttpRequest build(String method,String path,String user,Object body)throws Exception{var request=HttpRequest.newBuilder(URI.create(url+path)).timeout(Duration.ofSeconds(8));if(user!=null)request.header("Cookie",Auth.COOKIE_NAME+"="+token(user));if(!method.equals("GET"))request.header("X-Deepmark-Request","1");return request.method(method,body==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofString(Platform.JSON.writeValueAsString(body))).build();}
        HttpResponse<String> request(String method,String path,String user,Object body)throws Exception{return client.send(build(method,path,user,body),HttpResponse.BodyHandlers.ofString());}
        JsonNode json(HttpResponse<String> response)throws Exception{assertEquals(200,response.statusCode(),response.body());return Platform.JSON.readTree(response.body());}
        JsonNode join(String user)throws Exception{return json(request("POST",BASE+"/projects",user,Map.of("datasetId","dataset","fingerprint",fingerprint)));}
        JsonNode post(String project,String action,String user,Object body)throws Exception{return json(request("POST",BASE+"/projects/"+project+"/"+action,user,body));}
        JsonNode presence(String project,String user)throws Exception{return json(request("GET",BASE+"/projects/"+project+"/presence",user,null)).path("members");}
        JsonNode awaitMembers(String project,int count)throws Exception{long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);JsonNode members;do{members=presence(project,"worker-a");if(members.size()==count)return members;Thread.sleep(20);}while(System.nanoTime()<until);assertEquals(count,members.size());return members;}
        WebSocket socket(String project,String user,Listener listener){return client.newWebSocketBuilder().header("Cookie",Auth.COOKIE_NAME+"="+token(user)).buildAsync(URI.create(url.replace("http:","ws:")+BASE+"/socket?project="+project),listener).join();}
        public void close(){app.stop();platform.close();}
    }
}
