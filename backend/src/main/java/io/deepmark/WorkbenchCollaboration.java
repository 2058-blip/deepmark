package io.deepmark;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.javalin.Javalin;
import io.javalin.http.*;
import io.javalin.websocket.WsContext;
import java.io.*;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.*;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;

/** Native workbench transport attached to the existing account/group/task platform.
 * Only completed result deltas cross this boundary; no pointer/brush trajectories. */
public final class WorkbenchCollaboration {
    public static final String BASE="/api/collaboration/workbenches",SOCKET="/api/collaboration/workbench-socket";
    private static final int MAX_PACKET=4*1024*1024,MAX_META=8*1024*1024,PACKET_RECORDS=(256*1024-12)/12;
    private final Platform platform;
    private final LinkedHashMap<String,Cached> cache=new LinkedHashMap<>(8,.75f,true);
    private final ConcurrentHashMap<String,Peer> peers=new ConcurrentHashMap<>();
    private record Row(String id,String dataset,String fingerprint,int count,long revision) {}
    private record Cached(long revision,WorkbenchModel model) {}
    private record Peer(WsContext context,String cookie,String project,String dataset,String user) {}
    @FunctionalInterface private interface Action {Object run()throws Exception;}
    public WorkbenchCollaboration(Platform platform){
        this.platform=platform;
        platform.db.transaction(c->{try(Statement s=c.createStatement()){
            s.execute("CREATE TABLE IF NOT EXISTS wb_projects(id TEXT PRIMARY KEY,dataset TEXT NOT NULL REFERENCES datasets(id),fingerprint TEXT NOT NULL,count INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 0,manifest TEXT NOT NULL,owners TEXT NOT NULL,created TEXT NOT NULL,UNIQUE(dataset,fingerprint))");
            s.execute("CREATE TABLE IF NOT EXISTS wb_seed(project TEXT PRIMARY KEY,manifest TEXT NOT NULL,owners TEXT NOT NULL,created TEXT NOT NULL)");
            s.execute("CREATE TABLE IF NOT EXISTS wb_seed_claims(project TEXT NOT NULL,mask TEXT NOT NULL,author TEXT NOT NULL,bits BLOB NOT NULL,PRIMARY KEY(project,mask,author))");
            s.execute("CREATE TABLE IF NOT EXISTS wb_claims(project TEXT NOT NULL REFERENCES wb_projects(id),mask TEXT NOT NULL,author TEXT NOT NULL,bits BLOB NOT NULL,PRIMARY KEY(project,mask,author))");
            s.execute("CREATE TABLE IF NOT EXISTS wb_events(project TEXT NOT NULL,revision INTEGER NOT NULL,op TEXT NOT NULL,author TEXT NOT NULL,name TEXT NOT NULL,kind TEXT NOT NULL,time TEXT NOT NULL,base INTEGER NOT NULL,changes TEXT NOT NULL,event TEXT NOT NULL,PRIMARY KEY(project,revision),UNIQUE(project,op))");
            s.execute("CREATE TABLE IF NOT EXISTS wb_input_parts(project TEXT NOT NULL,op TEXT NOT NULL,author TEXT NOT NULL,n INTEGER NOT NULL,mask TEXT NOT NULL,hash TEXT NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(project,op,n))");
            s.execute("CREATE TABLE IF NOT EXISTS wb_event_parts(project TEXT NOT NULL,revision INTEGER NOT NULL,n INTEGER NOT NULL,mask TEXT NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(project,revision,n))");
            s.execute("CREATE TABLE IF NOT EXISTS wb_aliases(project TEXT NOT NULL,author TEXT NOT NULL,collection TEXT NOT NULL,original TEXT NOT NULL,target TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(project,author,collection,original))");
            s.execute("CREATE TABLE IF NOT EXISTS wb_resources(project TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,length INTEGER NOT NULL,maximum INTEGER NOT NULL,bytes BLOB NOT NULL,author TEXT NOT NULL,PRIMARY KEY(project,id))");
        }return null;});
        platform.onDatasetCompleted(id->{
            for(Peer peer:peers.values())if(peer.dataset.equals(id))send(peer,map("type","access","canWrite",false,"datasetStatus","completed"));
        });
    }
    public void install(Javalin app){
        app.before(ctx->{String path=ctx.path();if((path.equals(BASE)||path.startsWith(BASE+"/"))&&!Set.of("GET","HEAD","OPTIONS").contains(ctx.method().name())){platform.auth.checkMutation(ctx);Auth.User user=platform.auth.require(ctx);String expected=ctx.header("X-Workbench-Author");if(expected!=null&&!java.net.URLDecoder.decode(expected,StandardCharsets.UTF_8).equals(user.id()))throw new UnauthorizedResponse("账户身份已变化，请重新进入工作台。");}});
        app.post(BASE,ctx->answer(ctx,()->join(platform.auth.require(ctx),text(body(ctx),"datasetId"),text(body(ctx),"fingerprint"))));
        app.get(BASE+"/{id}",ctx->answer(ctx,()->snapshot(platform.auth.require(ctx),ctx.pathParam("id"),optional(ctx.queryParam("revision")))));
        app.get(BASE+"/{id}/history",ctx->answer(ctx,()->history(platform.auth.require(ctx),ctx.pathParam("id"))));
        app.get(BASE+"/{id}/legacy",ctx->answer(ctx,()->legacySnapshot(platform.auth.require(ctx),ctx.pathParam("id"),number(ctx.queryParam("revision"),-1))));
        app.get(BASE+"/{id}/events",ctx->answer(ctx,()->events(platform.auth.require(ctx),ctx.pathParam("id"),number(ctx.queryParam("after"),0))));
        app.get(BASE+"/{id}/presence",ctx->answer(ctx,()->{readable(platform.auth.require(ctx),ctx.pathParam("id"));return presence(ctx.pathParam("id"));}));
        app.get(BASE+"/{id}/provenance",ctx->answer(ctx,()->provenance(platform.auth.require(ctx),ctx.pathParam("id"),number(ctx.queryParam("index"),-1))));
        app.get(BASE+"/{id}/mask",ctx->answer(ctx,()->{
            Auth.User user=platform.auth.require(ctx);String id=ctx.pathParam("id"),mask=Objects.toString(ctx.queryParam("mask"),"");
            WorkbenchModel model=platform.db.read(c->{Row row=readable(c,user,id);return ctx.queryParam("legacyRevision")==null?model(c,row,optional(ctx.queryParam("revision"))):legacyModel(user,row,number(ctx.queryParam("legacyRevision"),-1));});
            String author=ctx.queryParam("author");
            ctx.contentType("application/x-deepmark-mask-stream").result(new MaskStream((author==null?model.snapshotRuns(mask):model.claimRuns(mask,author)).iterator()));return null;
        }));
        app.put(BASE+"/{id}/operations/{op}/parts/{n}",ctx->answer(ctx,()->{
            String codec=Objects.toString(ctx.header("X-Deepmark-Codec"),"raw");byte[] bytes=ctx.bodyAsBytes();
            if(bytes.length>MAX_PACKET)throw new HttpResponseException(413,"标注分块过大。");
            if(codec.equals("gzip"))bytes=Nifti.gunzip(bytes,MAX_PACKET);else if(!codec.equals("raw"))throw new BadRequestResponse("分块编码无效。");
            String mask=java.net.URLDecoder.decode(Objects.toString(ctx.header("X-Mask-Id"),""),StandardCharsets.UTF_8);
            return stage(platform.auth.require(ctx),ctx.pathParam("id"),ctx.pathParam("op"),Integer.parseInt(ctx.pathParam("n")),mask,bytes);
        }));
        app.post(BASE+"/{id}/operations",ctx->answer(ctx,()->commit(platform.auth.require(ctx),ctx.pathParam("id"),body(ctx))));
        app.get(BASE+"/{id}/events/{revision}/parts/{n}",ctx->answer(ctx,()->{
            Auth.User user=platform.auth.require(ctx);String id=ctx.pathParam("id");byte[] bytes=platform.db.read(c->{readable(c,user,id);Map<String,Object> part=one(c,"SELECT bytes FROM wb_event_parts WHERE project=? AND revision=? AND n=?",id,number(ctx.pathParam("revision"),-1),number(ctx.pathParam("n"),-1));if(part==null)throw new NotFoundResponse("操作分块不存在。");return (byte[])part.get("bytes");});
            ctx.contentType("application/octet-stream").header("Content-Encoding","gzip").result(bytes);return null;
        }));
        app.put(BASE+"/{id}/resources/{resource}",ctx->answer(ctx,()->resource(platform.auth.require(ctx),ctx.pathParam("id"),ctx.pathParam("resource"),ctx.bodyAsBytes())));
        app.get(BASE+"/{id}/resources/{resource}",ctx->answer(ctx,()->{
            Auth.User user=platform.auth.require(ctx);String id=ctx.pathParam("id");byte[] bytes=platform.db.read(c->{readable(c,user,id);Map<String,Object> found=one(c,"SELECT bytes FROM wb_resources WHERE project=? AND id=?",id,ctx.pathParam("resource"));if(found==null)throw new NotFoundResponse("模型资源不存在。");return (byte[])found.get("bytes");});
            ctx.contentType("application/octet-stream").result(bytes);return null;
        }));
        app.wsBeforeUpgrade(ctx->{if(!ctx.path().equals(SOCKET))return;platform.auth.checkWebSocket(ctx);Auth.User user=platform.auth.require(ctx);if(ctx.queryParam("author")!=null&&!user.id().equals(ctx.queryParam("author")))throw new UnauthorizedResponse("账户身份已变化。");readable(user,ctx.queryParam("project"));});
        app.ws(SOCKET,ws->{
            ws.onConnect(ctx->{
                try{Auth.User user=platform.auth.fromCookie(ctx.header("Cookie"));Row row=readable(user,ctx.queryParam("project"));
                    ctx.session.setMaxTextMessageSize(4096);Peer peer=new Peer(ctx,ctx.header("Cookie"),row.id,row.dataset,user.id());peers.put(ctx.sessionId(),peer);
                    send(peer,map("type","ready","revision",row.revision,"canWrite",canWrite(user,row.dataset),"datasetStatus",platform.dataset(row.dataset).get("status")));broadcastPresence(row.id);
                }catch(RuntimeException error){ctx.closeSession(1008,"Unauthorized");}
            });
            ws.onMessage(ctx->{Peer peer=peers.get(ctx.sessionId());if(peer==null)return;try{Auth.User user=peerUser(peer);send(peer,map("type","pong","revision",readable(user,peer.project).revision,"canWrite",canWrite(user,peer.dataset),"datasetStatus",platform.dataset(peer.dataset).get("status")));}catch(RuntimeException error){ctx.closeSession(1008,"Access revoked");}});
            ws.onClose(ctx->leave(ctx.sessionId()));ws.onError(ctx->leave(ctx.sessionId()));
        });
        ScheduledExecutorService checks=Executors.newSingleThreadScheduledExecutor(task->{Thread t=new Thread(task,"workbench-presence");t.setDaemon(true);return t;});
        app.events(events->{events.serverStarted(()->checks.scheduleWithFixedDelay(()->{for(Peer peer:peers.values())try{peerUser(peer);}catch(RuntimeException error){peer.context.closeSession(1008,"Access revoked");leave(peer.context.sessionId());}},5,5,TimeUnit.SECONDS));events.serverStopping(checks::shutdownNow);});
    }
    private void answer(Context ctx,Action action)throws Exception{
        try{Object result=action.run();if(result!=null)ctx.json(result);}
        catch(IllegalArgumentException error){throw new BadRequestResponse(error.getMessage());}
    }
    public Map<String,Object> join(Auth.User user,String dataset,String fingerprint){
        platform.requireRead(user,dataset);Datasets.Geometry geometry=platform.datasets.geometry(dataset);
        if(!geometry.fingerprint().equals(fingerprint))throw new ConflictResponse("服务器影像已变化，请重新下载。");
        String id=sha(("workbench:"+dataset+":"+fingerprint).getBytes(StandardCharsets.UTF_8)).substring(0,32);
        platform.db.transaction(c->{platform.requireRead(user,dataset);if(one(c,"SELECT id FROM wb_projects WHERE id=?",id)==null){
            Collaboration.NativeExport migrated=platform.legacyCollaboration==null?null:platform.legacyCollaboration.nativeExport(user,dataset,fingerprint,null);
            WorkbenchModel initial=migrated==null?WorkbenchModel.empty(geometry.volume().count(),String.valueOf(geometry.metadata().get("name"))):migrated.model();
            int unit=geometry.volume().header()[123]&7;initial.manifest.put("rawUnit",unit);initial.manifest.put("sourceUnit",unit>=1&&unit<=3?unit:0);
            exec(c,"INSERT INTO wb_projects VALUES(?,?,?,?,0,?,?,?)",id,dataset,fingerprint,geometry.volume().count(),json(initial.manifest),json(initial.owners),json(initial.created));
            exec(c,"INSERT INTO wb_seed VALUES(?,?,?,?)",id,json(initial.manifest),json(initial.owners),json(initial.created));
            for(var layer:initial.layers.entrySet())for(var author:layer.getValue().authors.entrySet()){byte[] bits=Nifti.gzip(author.getValue().toByteArray());exec(c,"INSERT INTO wb_claims VALUES(?,?,?,?)",id,layer.getKey(),author.getKey(),bits);exec(c,"INSERT INTO wb_seed_claims VALUES(?,?,?,?)",id,layer.getKey(),author.getKey(),bits);}
            remember(id,0,initial);
        }else{
            Row existing=readable(c,user,id);WorkbenchModel stored=model(c,existing,null);
            if(!stored.manifest.has("rawUnit")){int unit=geometry.volume().header()[123]&7;ObjectNode manifest=stored.manifest.deepCopy();manifest.put("rawUnit",unit);manifest.put("sourceUnit",unit>=1&&unit<=3?unit:0);exec(c,"UPDATE wb_projects SET manifest=? WHERE id=?",json(manifest),id);remember(id,existing.revision,new WorkbenchModel(stored.count,manifest,stored.layers,stored.owners,stored.created));}
        }return null;});
        return snapshot(user,id,null);
    }
    public Map<String,Object> snapshot(Auth.User user,String id,Long revision){
        return platform.db.read(c->{Row row=readable(c,user,id);WorkbenchModel model=model(c,row,revision);long version=revision==null?row.revision:revision;
            List<Map<String,Object>> claims=new ArrayList<>();
            for(var layer:model.layers.entrySet())for(var author:layer.getValue().authors.entrySet())if(!author.getValue().isEmpty())
                claims.add(map("mask",layer.getKey(),"author",author.getKey(),"name",authorName(c,author.getKey())));
            return map("id",id,"datasetId",row.dataset,"fingerprint",row.fingerprint,"count",row.count,"revision",version,"latestRevision",row.revision,"claims",claims,
                "manifest",model.manifest,"canWrite",revision==null&&canWrite(user,row.dataset),"datasetStatus",platform.dataset(row.dataset).get("status"),
                "maskBase",BASE+"/"+id+"/mask?revision="+version+"&mask=","resourceBase",BASE+"/"+id+"/resources/");
        });
    }
    public Map<String,Object> stage(Auth.User user,String id,String op,int n,String mask,byte[] bytes){
        WorkbenchModel.validId(op);WorkbenchModel.validId(mask);if(n<0||n>100000||bytes.length>MAX_PACKET)throw new BadRequestResponse("操作分块编号或大小无效。");
        return platform.db.transaction(c->{Row row=readable(c,user,id);platform.requireWrite(user,row.dataset);WorkbenchModel.decode(bytes,row.count);
            Map<String,Object> old=one(c,"SELECT author,hash FROM wb_input_parts WHERE project=? AND op=? AND n=?",id,op,n);String hash=sha(bytes);
            if(old!=null){if(!user.id().equals(old.get("author"))||!hash.equals(old.get("hash")))throw new ConflictResponse("操作分块编号已被使用。");return map("ok",true,"duplicate",true);}
            exec(c,"INSERT INTO wb_input_parts VALUES(?,?,?,?,?,?,?)",id,op,user.id(),n,mask,hash,Nifti.gzip(bytes));return map("ok",true);
        });
    }
    public Map<String,Object> commit(Auth.User user,String id,JsonNode request){
        String op=text(request,"op");WorkbenchModel.validId(op);long base=request.path("baseRevision").asLong(-1);int total=request.path("parts").asInt(-1);
        if(base<0||total<0||total>100000)throw new BadRequestResponse("操作版本或分块数量无效。");
        Map<String,Object> result=platform.db.transaction(c->{
            Row row=readable(c,user,id);platform.requireWrite(user,row.dataset);
            Map<String,Object> duplicate=one(c,"SELECT author,event FROM wb_events WHERE project=? AND op=?",id,op);
            if(duplicate!=null){if(!user.id().equals(duplicate.get("author")))throw new ConflictResponse("操作编号属于其他作者。");return map("duplicate",true,"event",parse((String)duplicate.get("event")));}
            if(base>row.revision)throw new ConflictResponse("操作引用了未来修订。");
            List<Map<String,Object>> parts=rows(c,"SELECT n,mask,author,bytes FROM wb_input_parts WHERE project=? AND op=? ORDER BY n",id,op);
            if(parts.size()!=total)throw new ConflictResponse("标注分块尚未完整上传。");
            List<WorkbenchModel.Patch> patches=new ArrayList<>();
            for(int i=0;i<parts.size();i++){Map<String,Object> part=parts.get(i);if(((Number)part.get("n")).intValue()!=i||!user.id().equals(part.get("author")))throw new ConflictResponse("标注分块不完整或作者不一致。");patches.add(new WorkbenchModel.Patch((String)part.get("mask"),WorkbenchModel.decode(Nifti.gunzip((byte[])part.get("bytes"),MAX_PACKET),row.count)));}
            JsonNode changes=request.path("changes");validateTree(changes,0);validateResources(c,id,changes);
            WorkbenchModel before=model(c,row,null);long revision=row.revision+1;
            Rewrite rewrite=rewriteAliases(c,id,user.id(),base,changes,patches);changes=rewrite.changes;patches=rewrite.patches;
            WorkbenchModel.Result applied=before.apply(user,base,revision,op,changes,patches);WorkbenchModel after=applied.model();
            String kind=request.path("kind").asText("标注");if(kind.length()>160)throw new BadRequestResponse("操作名称过长。");
            ObjectNode event=Platform.JSON.createObjectNode();event.put("revision",revision);event.put("op",op);event.put("author",user.id());event.put("name",user.name());event.put("kind",kind);event.put("time",Instant.now().toString());
            event.set("changes",metadataDelta(before.manifest,after.manifest));Map<String,String> renamed=new LinkedHashMap<>(rewrite.renamed);renamed.putAll(applied.renamed());event.set("renamed",Platform.JSON.valueToTree(renamed));event.set("inputMaskAliases",Platform.JSON.valueToTree(rewrite.masks));
            for(var alias:applied.renamed().entrySet()){int slash=alias.getKey().indexOf('/');exec(c,"INSERT OR REPLACE INTO wb_aliases VALUES(?,?,?,?,?,?)",id,user.id(),alias.getKey().substring(0,slash),alias.getKey().substring(slash+1),alias.getValue(),revision);}
            ArrayNode descriptors=event.putArray("parts");int index=0;
            for(String mask:applied.changedMasks())if(after.layers.containsKey(mask)){
                BitSet old=before.layers.containsKey(mask)?before.layers.get(mask).union:new BitSet();List<WorkbenchModel.Run> batch=new ArrayList<>();
                for(WorkbenchModel.Run run:WorkbenchModel.deltaRuns(old,after.layers.get(mask).union)){
                    batch.add(run);if(batch.size()==PACKET_RECORDS){storeEventPart(c,id,revision,index,mask,batch);descriptors.addObject().put("n",index++).put("mask",mask).put("scope","union");batch.clear();}
                }
                if(!batch.isEmpty()){storeEventPart(c,id,revision,index,mask,batch);descriptors.addObject().put("n",index++).put("mask",mask).put("scope","union");}
            }
            for(var entry:after.layers.entrySet()){
                BitSet old=before.layers.containsKey(entry.getKey())?before.layers.get(entry.getKey()).authors.getOrDefault(user.id(),new BitSet()):new BitSet();
                BitSet own=entry.getValue().authors.getOrDefault(user.id(),new BitSet());if(old.equals(own))continue;
                List<WorkbenchModel.Run> batch=new ArrayList<>();
                for(WorkbenchModel.Run run:WorkbenchModel.deltaRuns(old,own)){
                    batch.add(run);if(batch.size()==PACKET_RECORDS){storeEventPart(c,id,revision,index,entry.getKey(),batch);descriptors.addObject().put("n",index++).put("mask",entry.getKey()).put("scope","claim").put("author",user.id());batch.clear();}
                }
                if(!batch.isEmpty()){storeEventPart(c,id,revision,index,entry.getKey(),batch);descriptors.addObject().put("n",index++).put("mask",entry.getKey()).put("scope","claim").put("author",user.id());}
            }
            int updated=exec(c,"UPDATE wb_projects SET revision=?,manifest=?,owners=?,created=? WHERE id=? AND revision=?",revision,json(after.manifest),json(after.owners),json(after.created),id,row.revision);
            if(updated!=1)throw new ConflictResponse("工程已被其他操作更新，请重试。");
            for(String mask:before.layers.keySet())if(!after.layers.containsKey(mask))exec(c,"DELETE FROM wb_claims WHERE project=? AND mask=?",id,mask);
            for(var layer:after.layers.entrySet())if(before.layers.get(layer.getKey())!=layer.getValue()){
                BitSet own=layer.getValue().authors.get(user.id());if(own!=null)exec(c,"INSERT OR REPLACE INTO wb_claims VALUES(?,?,?,?)",id,layer.getKey(),user.id(),Nifti.gzip(own.toByteArray()));
            }
            exec(c,"INSERT INTO wb_events VALUES(?,?,?,?,?,?,?,?,?,?)",id,revision,op,user.id(),user.name(),kind,event.path("time").asText(),base,json(changes),json(event));
            remember(id,revision,after);return map("event",event,"protectedCount",applied.protectedCount());
        });
        JsonNode event=Platform.JSON.valueToTree(result.get("event"));
        broadcast(id,map("type","committed","revision",event.path("revision").asLong(),"op",op));
        return result;
    }
    private record Rewrite(JsonNode changes,List<WorkbenchModel.Patch> patches,Map<String,String> renamed,Map<String,String> masks){}
    private Rewrite rewriteAliases(Connection c,String project,String author,long base,JsonNode changes,List<WorkbenchModel.Patch> patches)throws SQLException{
        ObjectNode effective=changes.isObject()?((ObjectNode)changes).deepCopy():Platform.JSON.createObjectNode();Map<String,String> renamed=new LinkedHashMap<>(),masks=new LinkedHashMap<>(),early=new LinkedHashMap<>();
        for(Map<String,Object> alias:rows(c,"SELECT collection,original,target,revision FROM wb_aliases WHERE project=? AND author=?",project,author)){
            String collection=(String)alias.get("collection"),original=(String)alias.get("original"),target=(String)alias.get("target");boolean unseen=base<((Number)alias.get("revision")).longValue();
            if(collection.equals("masks")&&unseen)masks.put(original,target);if(unseen)early.put(collection+"/"+original,target);
            if(!collection.equals("masks")||unseen)for(JsonNode row:effective.path("upserts").path(collection))if(row.path("id").asText().equals(original)){((ObjectNode)row).put("id",target);renamed.put(collection+"/"+original,target);}
            JsonNode removed=effective.path("removals").path(collection);if(unseen&&removed.isArray())for(int i=0;i<removed.size();i++)if(removed.get(i).asText().equals(original))((ArrayNode)removed).set(i,Platform.JSON.getNodeFactory().textNode(target));
        }
        for(String collection:WorkbenchModel.COLLECTIONS)for(JsonNode row:effective.path("upserts").path(collection)){
            for(String field:List.of("sourceMaskId","sourcePartId","partId"))if(row.has(field)){String category=field.equals("sourceMaskId")?"masks":"parts",target=early.get(category+"/"+row.path(field).asText());if(target!=null)((ObjectNode)row).put(field,target);}
            JsonNode ids=row.path("pointPartIds");if(ids.isArray())for(int i=0;i<ids.size();i++){String target=early.get("parts/"+ids.get(i).asText());if(target!=null)((ArrayNode)ids).set(i,Platform.JSON.getNodeFactory().textNode(target));}
        }
        List<WorkbenchModel.Patch> result=new ArrayList<>();for(WorkbenchModel.Patch patch:patches)result.add(new WorkbenchModel.Patch(masks.getOrDefault(patch.mask(),patch.mask()),patch.runs()));
        return new Rewrite(effective,result,renamed,masks);
    }
    private void storeEventPart(Connection c,String id,long revision,int n,String mask,List<WorkbenchModel.Run> runs)throws SQLException{
        exec(c,"INSERT INTO wb_event_parts VALUES(?,?,?,?,?)",id,revision,n,mask,Nifti.gzip(WorkbenchModel.encode(runs)));
    }
    public Map<String,Object> events(Auth.User user,String id,long after){
        if(after<0)throw new BadRequestResponse("起始修订无效。");
        return platform.db.read(c->{Row row=readable(c,user,id);List<JsonNode> result=new ArrayList<>();for(Map<String,Object> entry:rows(c,"SELECT event FROM wb_events WHERE project=? AND revision>? ORDER BY revision LIMIT 100",id,after))result.add(parse((String)entry.get("event")));return map("events",result,"revision",row.revision,"canWrite",canWrite(user,row.dataset),"datasetStatus",platform.dataset(row.dataset).get("status"));});
    }
    public Map<String,Object> resource(Auth.User user,String id,String resource,byte[] bytes){
        if(!resource.matches("(f32|u32|u8|json)-[a-f0-9]{64}")||bytes.length>512L*1024*1024)throw new BadRequestResponse("模型资源编号或大小无效。");
        String kind=resource.substring(0,resource.indexOf('-'));if(!resource.endsWith(sha(bytes)))throw new BadRequestResponse("模型资源校验失败。");
        if(!kind.equals("u8")&&!kind.equals("json")&&bytes.length%4!=0)throw new BadRequestResponse("模型数组长度无效。");
        long maximum=0;if(kind.equals("f32")||kind.equals("u32")){ByteBuffer input=ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);while(input.remaining()>0){if(kind.equals("f32")){if(!Float.isFinite(input.getFloat()))throw new BadRequestResponse("模型包含非有限坐标。");}else maximum=Math.max(maximum,Integer.toUnsignedLong(input.getInt()));}}
        if(kind.equals("json")){if(bytes.length>MAX_META)throw new BadRequestResponse("对象元数据过大。");validateTree(parse(new String(bytes,StandardCharsets.UTF_8)),0);}
        long length=kind.equals("f32")||kind.equals("u32")?bytes.length/4:bytes.length,max=maximum;
        return platform.db.transaction(c->{Row row=readable(c,user,id);platform.requireWrite(user,row.dataset);exec(c,"INSERT OR IGNORE INTO wb_resources VALUES(?,?,?,?,?,?,?)",id,resource,kind,length,max,bytes,user.id());return map("id",resource,"kind",kind,"length",length);});
    }
    private WorkbenchModel model(Connection c,Row row,Long revision)throws Exception{
        if(revision!=null&&(revision<0||revision>row.revision))throw new NotFoundResponse("历史修订不存在。");
        if(revision==null||revision==row.revision){
            Cached cached=cache.get(row.id);if(cached!=null&&cached.revision==row.revision)return cached.model;
            Map<String,Object> data=one(c,"SELECT manifest,owners,created FROM wb_projects WHERE id=?",row.id);
            Map<String,WorkbenchModel.Layer> layers=new LinkedHashMap<>();ObjectNode manifest=(ObjectNode)parse((String)data.get("manifest"));
            for(JsonNode mask:manifest.path("masks"))layers.put(mask.path("id").asText(),new WorkbenchModel.Layer());
            for(Map<String,Object> claim:rows(c,"SELECT mask,author,bits FROM wb_claims WHERE project=?",row.id)){
                WorkbenchModel.Layer layer=layers.get(claim.get("mask"));if(layer==null)throw new IllegalStateException("Unknown cached Mask");
                BitSet bits=BitSet.valueOf(Nifti.gunzip((byte[])claim.get("bits"),(row.count+7)/8));if(bits.length()>row.count)throw new IllegalStateException("Claim outside image");
                layer.authors.put((String)claim.get("author"),bits);layer.union.or(bits);
            }
            Map<String,String> owners=new LinkedHashMap<>();parse((String)data.get("owners")).fields().forEachRemaining(e->owners.put(e.getKey(),e.getValue().asText()));
            Map<String,Long> created=new LinkedHashMap<>();parse((String)data.get("created")).fields().forEachRemaining(e->created.put(e.getKey(),e.getValue().asLong()));
            WorkbenchModel result=new WorkbenchModel(row.count,manifest,layers,owners,created);remember(row.id,row.revision,result);return result;
        }
        Map<String,Object> seed=one(c,"SELECT manifest,owners,created FROM wb_seed WHERE project=?",row.id);
        WorkbenchModel result;
        if(seed==null){
            result=WorkbenchModel.empty(row.count,String.valueOf(platform.dataset(row.dataset).get("name")));JsonNode currentManifest=parse((String)one(c,"SELECT manifest FROM wb_projects WHERE id=?",row.id).get("manifest"));int rawUnit=currentManifest.path("rawUnit").asInt();result.manifest.put("rawUnit",rawUnit);result.manifest.put("sourceUnit",rawUnit>=1&&rawUnit<=3?rawUnit:0);
        }else result=seedModel(c,row,seed);
        for(Map<String,Object> entry:rows(c,"SELECT * FROM wb_events WHERE project=? AND revision<=? ORDER BY revision",row.id,revision)){
            JsonNode oldEvent=parse((String)entry.get("event"));List<WorkbenchModel.Patch> patches=new ArrayList<>();for(Map<String,Object> part:rows(c,"SELECT mask,bytes FROM wb_input_parts WHERE project=? AND op=? ORDER BY n",row.id,entry.get("op"))){String original=(String)part.get("mask"),mask=oldEvent.path("inputMaskAliases").path(original).asText(original);patches.add(new WorkbenchModel.Patch(mask,WorkbenchModel.decode(Nifti.gunzip((byte[])part.get("bytes"),MAX_PACKET),row.count)));}
            Auth.User author=new Auth.User((String)entry.get("author"),"",(String)entry.get("name"),"worker");
            result=result.apply(author,((Number)entry.get("base")).longValue(),((Number)entry.get("revision")).longValue(),(String)entry.get("op"),parse((String)entry.get("changes")),patches).model();
        }
        return result;
    }
    private WorkbenchModel seedModel(Connection c,Row row,Map<String,Object> seed)throws Exception{
        ObjectNode manifest=(ObjectNode)parse((String)seed.get("manifest"));Map<String,WorkbenchModel.Layer> layers=new LinkedHashMap<>();for(JsonNode mask:manifest.path("masks"))layers.put(mask.path("id").asText(),new WorkbenchModel.Layer());
        for(Map<String,Object> claim:rows(c,"SELECT mask,author,bits FROM wb_seed_claims WHERE project=?",row.id)){WorkbenchModel.Layer layer=layers.get(claim.get("mask"));BitSet bits=BitSet.valueOf(Nifti.gunzip((byte[])claim.get("bits"),(row.count+7)/8));layer.authors.put((String)claim.get("author"),bits);layer.union.or(bits);}
        Map<String,String> owners=new LinkedHashMap<>();parse((String)seed.get("owners")).fields().forEachRemaining(e->owners.put(e.getKey(),e.getValue().asText()));Map<String,Long> created=new LinkedHashMap<>();parse((String)seed.get("created")).fields().forEachRemaining(e->created.put(e.getKey(),e.getValue().asLong()));return new WorkbenchModel(row.count,manifest,layers,owners,created);
    }
    private WorkbenchModel legacyModel(Auth.User user,Row row,long revision){
        if(platform.legacyCollaboration==null)throw new NotFoundResponse("旧版历史不可用。");Collaboration.NativeExport export=platform.legacyCollaboration.nativeExport(user,row.dataset,row.fingerprint,revision);if(export==null)throw new NotFoundResponse("旧版历史不存在。");
        WorkbenchModel model=export.model();platform.db.read(c->{JsonNode current=parse((String)one(c,"SELECT manifest FROM wb_projects WHERE id=?",row.id).get("manifest"));int raw=current.path("rawUnit").asInt();model.manifest.put("rawUnit",raw);model.manifest.put("sourceUnit",raw>=1&&raw<=3?raw:0);return null;});return model;
    }
    public Map<String,Object> legacySnapshot(Auth.User user,String id,long revision){return platform.db.read(c->{Row row=readable(c,user,id);WorkbenchModel model=legacyModel(user,row,revision);return map("id",id,"datasetId",row.dataset,"fingerprint",row.fingerprint,"count",row.count,"revision",revision,"latestRevision",row.revision,"manifest",model.manifest,"claims",List.of(),"canWrite",false,"historicalKind","legacy","datasetStatus",platform.dataset(row.dataset).get("status"),"maskBase",BASE+"/"+id+"/mask?legacyRevision="+revision+"&mask=","resourceBase",BASE+"/"+id+"/resources/");});}
    public Map<String,Object> history(Auth.User user,String id){return platform.db.read(c->{Row row=readable(c,user,id);List<Map<String,Object>> events=rows(c,"SELECT revision,op,author,name,kind,time FROM wb_events WHERE project=? ORDER BY revision DESC LIMIT 100",id);JsonNode manifest=parse((String)one(c,"SELECT manifest FROM wb_projects WHERE id=?",id).get("manifest"));List<Map<String,Object>> legacy=List.of();JsonNode source=manifest.path("legacySource");if(source.has("project")&&platform.tableExists("collab_events"))legacy=rows(c,"SELECT revision,op,author,name,kind,time FROM collab_events WHERE project=? ORDER BY revision DESC LIMIT 100",source.path("project").asText());return map("events",events,"legacy",legacy,"legacySource",source);});}
    public Map<String,Object> provenance(Auth.User user,String id,long index){
        return platform.db.read(c->{Row row=readable(c,user,id);if(index<0||index>=row.count)throw new BadRequestResponse("体素位置无效。");WorkbenchModel model=model(c,row,null);List<Map<String,Object>> result=new ArrayList<>();
            for(var layer:model.layers.entrySet())for(var author:layer.getValue().authors.entrySet())if(author.getValue().get((int)index)){Map<String,Object> profile=one(c,"SELECT id,name FROM users WHERE id=?",author.getKey());if(profile!=null)result.add(map("mask",layer.getKey(),"author",profile));}
            return map("index",index,"annotations",result);
        });
    }
    private Row readable(Auth.User user,String id){return platform.db.read(c->readable(c,user,id));}
    private Row readable(Connection c,Auth.User user,String id)throws SQLException{
        Map<String,Object> row=one(c,"SELECT id,dataset,fingerprint,count,revision FROM wb_projects WHERE id=?",id);if(row==null)throw new NotFoundResponse("共享工作台不存在。");
        platform.requireRead(user,(String)row.get("dataset"));return new Row(id,(String)row.get("dataset"),(String)row.get("fingerprint"),((Number)row.get("count")).intValue(),((Number)row.get("revision")).longValue());
    }
    private boolean canWrite(Auth.User user,String dataset){try{platform.requireWrite(user,dataset);return true;}catch(HttpResponseException error){return false;}}
    private static String authorName(Connection c,String author)throws SQLException{Map<String,Object> row=one(c,"SELECT name FROM users WHERE id=?",author);return row==null?"历史导入":String.valueOf(row.get("name"));}
    private void remember(String id,long revision,WorkbenchModel model){cache.put(id,new Cached(revision,model));while(cache.size()>3)cache.remove(cache.keySet().iterator().next());}
    private Auth.User peerUser(Peer peer){Auth.User user=platform.auth.fromCookie(peer.cookie);if(user==null||!user.id().equals(peer.user))throw new UnauthorizedResponse();platform.requireRead(user,peer.dataset);return user;}
    private Map<String,Object> presence(String project){Map<String,Auth.User> users=new LinkedHashMap<>();for(Peer peer:peers.values())if(peer.project.equals(project))try{Auth.User user=peerUser(peer);users.put(user.id(),user);}catch(RuntimeException ignored){}return map("members",users.values());}
    private void broadcastPresence(String id){broadcast(id,map("type","presence","members",presence(id).get("members")));}
    private void broadcast(String project,Object message){for(Peer peer:peers.values())if(peer.project.equals(project))try{peerUser(peer);send(peer,message);}catch(RuntimeException error){peer.context.closeSession(1008,"Access revoked");}}
    private void send(Peer peer,Object message){try{peer.context.send(json(message));}catch(RuntimeException ignored){}}
    private void leave(String session){Peer peer=peers.remove(session);if(peer!=null)broadcastPresence(peer.project);}
    private static void validateTree(JsonNode node,int depth){
        if(depth>32)throw new IllegalArgumentException("对象嵌套过深。");
        if(node.isNumber()&&!Double.isFinite(node.asDouble()))throw new IllegalArgumentException("对象包含非有限值。");
        if(node.isObject()){node.fields().forEachRemaining(e->{if(Set.of("__proto__","prototype","constructor").contains(e.getKey()))throw new IllegalArgumentException("对象字段无效。");validateTree(e.getValue(),depth+1);});}
        else if(node.isArray())for(JsonNode child:node)validateTree(child,depth+1);
    }
    private void validateResources(Connection c,String project,JsonNode node)throws SQLException{
        if(node.isObject()&&node.has("__workbenchResource")){
            JsonNode ref=node.get("__workbenchResource");Map<String,Object> found=one(c,"SELECT kind,length FROM wb_resources WHERE project=? AND id=?",project,ref.path("id").asText());
            if(found==null||!found.get("kind").equals(ref.path("kind").asText())||((Number)found.get("length")).longValue()!=ref.path("length").asLong(-1))throw new BadRequestResponse("对象引用未知或不匹配的资源。");return;
        }
        if(node.isContainerNode())for(JsonNode child:node)validateResources(c,project,child);
    }
    private static ObjectNode metadataDelta(ObjectNode before,ObjectNode after){
        ObjectNode result=Platform.JSON.createObjectNode(),upserts=result.putObject("upserts"),removals=result.putObject("removals");
        for(String field:List.of("name","resliceTransform","sourceUnit"))if(!Objects.equals(before.get(field),after.get(field)))result.set(field,after.has(field)?after.get(field).deepCopy():Platform.JSON.nullNode());
        for(String collection:WorkbenchModel.COLLECTIONS){
            ArrayNode old=before.withArray(collection),next=after.withArray(collection),added=upserts.putArray(collection),deleted=removals.putArray(collection);
            for(JsonNode item:next){int index=WorkbenchModel.find(old,item.path("id").asText());if(index<0||!old.get(index).equals(item))added.add(item.deepCopy());}
            for(JsonNode item:old)if(WorkbenchModel.find(next,item.path("id").asText())<0)deleted.add(item.path("id").asText());
        }
        return result;
    }
    private static JsonNode body(Context ctx){byte[] bytes=ctx.bodyAsBytes();if(bytes.length>MAX_META)throw new HttpResponseException(413,"对象元数据过大。");return parse(new String(bytes,StandardCharsets.UTF_8));}
    private static JsonNode parse(String text){try{return Platform.JSON.readTree(text);}catch(IOException error){throw new BadRequestResponse("请求或工程元数据无效。");}}
    private static String text(JsonNode node,String key){String value=node.path(key).asText("");if(value.isBlank())throw new BadRequestResponse("缺少 "+key);return value;}
    private static long number(String value,long fallback){if(value==null)return fallback;try{return Long.parseLong(value);}catch(NumberFormatException error){throw new BadRequestResponse("数值参数无效。");}}
    private static Long optional(String value){return value==null?null:number(value,-1);}
    private static String sha(byte[] bytes){try{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));}catch(Exception error){throw new IllegalStateException(error);}}
    private static String json(Object value){try{return Platform.JSON.writeValueAsString(value);}catch(Exception error){throw new IllegalStateException(error);}}
    private static Map<String,Object> map(Object... pairs){Map<String,Object> result=new LinkedHashMap<>();for(int i=0;i<pairs.length;i+=2)result.put((String)pairs[i],pairs[i+1]);return result;}
    private static int exec(Connection c,String sql,Object... values)throws SQLException{try(PreparedStatement statement=c.prepareStatement(sql)){for(int i=0;i<values.length;i++)statement.setObject(i+1,values[i]);return statement.executeUpdate();}}
    private static Map<String,Object> one(Connection c,String sql,Object... values)throws SQLException{List<Map<String,Object>> rows=rows(c,sql,values);return rows.isEmpty()?null:rows.get(0);}
    private static List<Map<String,Object>> rows(Connection c,String sql,Object... values)throws SQLException{
        try(PreparedStatement statement=c.prepareStatement(sql)){for(int i=0;i<values.length;i++)statement.setObject(i+1,values[i]);try(ResultSet result=statement.executeQuery()){List<Map<String,Object>> rows=new ArrayList<>();int count=result.getMetaData().getColumnCount();while(result.next()){Map<String,Object> row=new LinkedHashMap<>();for(int i=1;i<=count;i++)row.put(result.getMetaData().getColumnLabel(i),result.getObject(i));rows.add(row);}return rows;}}
    }
    /** Framed packets bound memory even for very fragmented Masks. */
    private static final class MaskStream extends InputStream{
        private final Iterator<WorkbenchModel.Run> runs;private byte[] buffer=new byte[0];private int offset;private boolean finished;
        MaskStream(Iterator<WorkbenchModel.Run> runs){this.runs=runs;}
        private void next(){
            if(finished){buffer=new byte[0];offset=0;return;}
            List<WorkbenchModel.Run> batch=new ArrayList<>();while(batch.size()<PACKET_RECORDS&&runs.hasNext())batch.add(runs.next());
            if(batch.isEmpty()){buffer=new byte[4];finished=true;}else{byte[] packet=WorkbenchModel.encode(batch);buffer=ByteBuffer.allocate(packet.length+4).order(ByteOrder.LITTLE_ENDIAN).putInt(packet.length).put(packet).array();}offset=0;
        }
        @Override public int read(){if(offset==buffer.length)next();return offset<buffer.length?buffer[offset++]&255:-1;}
        @Override public int read(byte[] target,int start,int length){if(length==0)return 0;if(offset==buffer.length)next();if(offset==buffer.length)return -1;int n=Math.min(length,buffer.length-offset);System.arraycopy(buffer,offset,target,start,n);offset+=n;return n;}
    }
}
