package io.deepmark;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.javalin.Javalin;
import io.javalin.http.Context;
import io.javalin.http.HttpResponseException;
import io.javalin.websocket.WsContext;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.BitSet;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/** Authenticated, task-scoped collaborative voxel editing and durable revision journal. */
public final class Collaboration {
    private static final String BASE = "/api/collaboration";
    private static final int MAX_PATCH = 32 * 1024 * 1024;
    private static final int MAX_MESSAGE = 46 * 1024 * 1024;
    private static final TypeReference<List<SharedModel.Author>> AUTHORS = new TypeReference<>() {};
    private static final TypeReference<List<SharedModel.Region>> REGIONS = new TypeReference<>() {};
    private static final TypeReference<List<Map<String,Object>>> LABELS = new TypeReference<>() {};
    private final Platform platform;
    /** Accessed only while holding the shared Database lock. */
    private final LinkedHashMap<String, Cached> models = new LinkedHashMap<>(8, .75f, true);
    /** Sparse same-label opinions omitted by the canonical mask/parallel-region representation. */
    private final LinkedHashMap<String,ClaimState> claimStates=new LinkedHashMap<>(8,.75f,true);
    private record ClaimState(long revision,Map<Integer,LinkedHashSet<String>> values,Set<Integer> regionPoints) {}
    private final long modelCacheBudget=Math.max(256L*1024*1024,Math.min(2L*1024*1024*1024,Runtime.getRuntime().maxMemory()/3));
    private final Map<String, Peer> peers = new ConcurrentHashMap<>();
    private record EncodedMask(long revision,String mask) {}
    private final Map<String,EncodedMask> encodedMasks=new ConcurrentHashMap<>();
    private final Set<String> checkpointPending=ConcurrentHashMap.newKeySet();
    private final java.util.concurrent.ExecutorService checkpoints=Executors.newSingleThreadExecutor(task->{Thread thread=new Thread(task,"deepmark-checkpoint");thread.setDaemon(true);return thread;});
    private record PackedSnapshot(byte[] mask,byte[] owners,byte[] authors,byte[] regions) {}
    private record Checkpoint(Project project,Map<String,Object> snapshot,List<Map<String,Object>> events) {}
    private record Cached(long revision, SharedModel.Model model) {}
    private record Project(String id, String dataset, String fingerprint, int count, byte[] header,
            int[] dims, boolean little, String name, List<Map<String,Object>> labels, long revision,
            String status, String finalizedBy, String finalizedAt, Long finalRevision) {}
    private record State(SharedModel.Model model, List<Map<String,Object>> labels, String status,
            String finalizedBy, String finalizedAt, Long finalRevision) {}
    private record Peer(WsContext context, String cookie, String project, String dataset, String userId) {}
    public static final class Failure extends RuntimeException {
        public final int status;
        public Failure(int status, String message) { super(message); this.status = status; }
    }
    @FunctionalInterface private interface HttpAction { Object run(Context context) throws Exception; }

    public Collaboration(Platform platform) {
        this.platform = platform;
        platform.legacyCollaboration=this;
        platform.db.read(c -> {try(Statement sql=c.createStatement()){sql.execute("PRAGMA synchronous=FULL");}return null;});
        platform.db.transaction(c -> {
            try (Statement sql = c.createStatement()) {
                sql.execute("CREATE TABLE IF NOT EXISTS collab_projects(id TEXT PRIMARY KEY,dataset TEXT NOT NULL,fingerprint TEXT NOT NULL,count INTEGER NOT NULL,header BLOB NOT NULL,dims TEXT NOT NULL,little INTEGER NOT NULL,name TEXT NOT NULL,labels TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'editing',finalized_by TEXT,finalized_at TEXT,final_revision INTEGER,UNIQUE(dataset,fingerprint))");
                sql.execute("CREATE TABLE IF NOT EXISTS collab_events(project TEXT NOT NULL,revision INTEGER NOT NULL,op TEXT NOT NULL,author TEXT NOT NULL,name TEXT NOT NULL,kind TEXT NOT NULL,time TEXT NOT NULL,details BLOB NOT NULL,PRIMARY KEY(project,revision),UNIQUE(project,op))");
                sql.execute("CREATE TABLE IF NOT EXISTS collab_snapshots(project TEXT NOT NULL,revision INTEGER NOT NULL,mask BLOB NOT NULL,owners BLOB NOT NULL,authors BLOB NOT NULL,regions BLOB NOT NULL,labels TEXT NOT NULL,status TEXT NOT NULL,finalized_by TEXT,finalized_at TEXT,final_revision INTEGER,PRIMARY KEY(project,revision))");
                sql.execute("CREATE INDEX IF NOT EXISTS collab_events_author ON collab_events(project,author,revision)");
                sql.execute("CREATE INDEX IF NOT EXISTS collab_dataset ON collab_projects(dataset)");
            }
            return null;
        });
        platform.onDatasetCompleted(this::datasetCompleted);
    }

    public void install(Javalin app) {
        // Expired sessions and revoked memberships must disappear even while no one edits.
        ScheduledExecutorService presenceChecks=Executors.newSingleThreadScheduledExecutor(task->{Thread thread=new Thread(task,"deepmark-presence");thread.setDaemon(true);return thread;});
        app.events(events->{events.serverStarted(()->presenceChecks.scheduleWithFixedDelay(this::refreshPresence,5,5,TimeUnit.SECONDS));events.serverStopping(()->{presenceChecks.shutdownNow();checkpoints.shutdownNow();});});
        app.before(BASE + "/*", ctx -> {if(!"GET".equals(ctx.req().getMethod()))platform.auth.checkMutation(ctx);});
        app.exception(Failure.class, (error, ctx) -> ctx.status(error.status).json(map("error", error.getMessage())));
        app.exception(SharedModel.Failure.class, (error, ctx) -> ctx.status(error.status).json(map("error", error.getMessage())));
        app.get(BASE + "/session", ctx -> ctx.json(map("person", platform.auth.current(ctx))));
        app.post(BASE + "/session", ctx -> { throw new Failure(410, "请使用账户登录，昵称会话已停用。"); });
        app.post(BASE + "/admin/session", ctx -> { throw new Failure(410, "旧管理员密钥登录已停用。"); });
        app.post(BASE + "/logout", ctx -> { throw new Failure(410, "请使用账户退出接口。"); });
        app.post(BASE + "/projects", ctx -> {
            Auth.User user = user(ctx); JsonNode body = body(ctx);
            ctx.json(join(user, text(body, "datasetId"), text(body, "fingerprint")));
        });
        app.get(BASE + "/projects/{id}", ctx -> {
            Auth.User user = user(ctx); String id = ctx.pathParam("id");
            Long revision = optionalLong(ctx.queryParam("revision")); Long unchanged = optionalLong(ctx.queryParam("ifRevision"));
            ctx.json(encodeState(platform.db.read(c -> {
                Project p = readable(c, user, id);
                // canWrite and datasetStatus must still be refreshed when a task is completed.
                if (revision == null && unchanged != null && unchanged == p.revision && !completed(p.dataset))
                    return map("unchanged", true, "revision", p.revision, "canWrite", canWrite(user,p.dataset), "datasetStatus", platform.dataset(p.dataset).get("status"));
                return state(c,p,revision,user);
            })));
        });
        app.get(BASE + "/projects/{id}/history", ctx -> {
            Auth.User user = user(ctx);
            ctx.json(platform.db.read(c -> { Project p=readable(c,user,ctx.pathParam("id")); return map("events", history(c,p.id)); }));
        });
        app.get(BASE + "/projects/{id}/presence", ctx -> {
            Auth.User user=user(ctx);String id=ctx.pathParam("id");
            platform.db.read(c->{readable(c,user,id);return null;});
            ctx.json(presence(id));
        });
        app.get(BASE + "/projects/{id}/events", ctx -> {
            Auth.User user = user(ctx); Long after=optionalLong(ctx.queryParam("after"));
            if(after==null)throw new Failure(400,"需要起始修订号。");
            ctx.json(platform.db.read(c -> {Project p=readable(c,user,ctx.pathParam("id"));return updates(c,p,after);}));
        });
        app.get(BASE + "/projects/{id}/provenance", ctx -> {
            Auth.User user=user(ctx);Long index=optionalLong(ctx.queryParam("index")), revision=optionalLong(ctx.queryParam("revision"));
            if(index==null||revision==null)throw new Failure(400,"需要体素索引与修订号。");
            ctx.json(platform.db.read(c->{Project p=readable(c,user,ctx.pathParam("id"));return provenance(c,p,index,revision,"1".equals(ctx.queryParam("historical")));}));
        });
        for (String action : List.of("operations","labels","resolve","finalize","reopen")) {
            app.post(BASE + "/projects/{id}/" + action, ctx -> {
                Auth.User user=user(ctx);JsonNode request=body(ctx);String id=ctx.pathParam("id");
                Map<String,Object> result=mutate(id,user,action,request);ctx.json(result);
            });
        }
        app.get(BASE + "/projects/{id}/export", ctx -> {
            Auth.User user=user(ctx);String id=ctx.pathParam("id");Long revision=optionalLong(ctx.queryParam("revision"));
            Map<String,Object> result=platform.db.read(c->{Project p=readable(c,user,id);if(user.role().equals("dispatcher")&&!completed(p.dataset))throw new Failure(403,"任务完成后才能下载成果。");return archive(c,p,revision);});
            ctx.contentType("application/zip").header("Content-Disposition","attachment; filename=\"deepmark-"+id+"-r"+result.get("revision")+".zip\"").result((byte[])result.get("bytes"));
        });
        app.wsBeforeUpgrade(ctx -> {
            if(!ctx.path().equals(BASE+"/socket"))return;
            platform.auth.checkWebSocket(ctx);
            Auth.User user=user(ctx);String id=ctx.queryParam("project");
            platform.db.read(c->{readable(c,user,id);return null;});
        });
        app.ws(BASE + "/socket", ws -> {
            ws.onConnect(ctx -> {
                try {
                    String cookie=ctx.header("Cookie"),id=ctx.queryParam("project");Auth.User user=platform.auth.fromCookie(cookie);
                    Project p=platform.db.read(c->readable(c,user,id));
                    ctx.session.setMaxTextMessageSize(MAX_MESSAGE);
                    ctx.session.setMaxBinaryMessageSize(MAX_MESSAGE);
                    Peer peer=new Peer(ctx,cookie,id,p.dataset,user.id());peers.put(ctx.sessionId(),peer);
                    long readyRevision=platform.db.read(c->project(c,id).revision);
                    send(peer,map("type","ready","projectId",id,"revision",readyRevision,"canWrite",canWrite(user,p.dataset),"datasetStatus",platform.dataset(p.dataset).get("status")));
                    broadcastPresence(id);
                } catch(RuntimeException error) {ctx.closeSession(1008,"Unauthorized project");}
            });
            ws.onMessage(ctx -> {
                Peer peer=peers.get(ctx.sessionId());if(peer==null){ctx.closeSession(1008,"Unauthorized project");return;}
                String requestId="";
                try {
                    if(ctx.message().length()>MAX_MESSAGE)throw new Failure(413,"操作数据超过上限。");
                    JsonNode message=platform.mapper.readTree(ctx.message());requestId=text(message,"requestId");
                    Auth.User user=platform.auth.fromCookie(peer.cookie);
                    if(user==null||!user.id().equals(text(message,"author")))throw new Failure(401,"当前账户身份已变化，请重新登录。");
                    String type=text(message,"type");JsonNode operation=message.get("operation");
                    if(!List.of("operation","label").contains(type)||!validId(requestId)||operation==null||!requestId.equals(text(operation,"op")))throw new Failure(400,"实时操作格式无效。");
                    long started=System.nanoTime();Map<String,Object> result=mutate(peer.project,user,type.equals("label")?"labels":"operations",operation);
                    Map<String,Object> ack=map("type","ack","requestId",requestId,"serverMs",(System.nanoTime()-started)/1_000_000.0);ack.putAll(result);send(peer,ack);
                } catch(Exception error) {send(peer,map("type","error","requestId",requestId,"status",status(error),"message",safeMessage(error)));}
            });
            ws.onClose(ctx -> peerLeft(ctx.sessionId()));
            ws.onError(ctx -> {peerLeft(ctx.sessionId());ctx.closeSession(1011,"Connection failed");});
        });
    }

    private Map<String,Object> join(Auth.User user,String dataset,String expectedFingerprint) {
        if(expectedFingerprint==null||!expectedFingerprint.matches("[a-f0-9]{64}"))throw new Failure(400,"加入工程时必须提供已下载影像的 SHA-256 指纹。");
        platform.requireRead(user,dataset);
        if(nativeOnly(dataset))throw new Failure(409,"该数据集已接入标注工作台，请使用新版工作台。");
        // File I/O and CT decompression must never hold the shared database lock.
        Datasets.Geometry source=platform.datasets.geometry(dataset);
        String fingerprint=source.fingerprint();
        if(!expectedFingerprint.equals(fingerprint))throw new Failure(409,"服务器影像已变化，请重新下载后再打开工程。");
        Nifti.Volume volume=source.volume();String id=sha256((dataset+fingerprint).getBytes(StandardCharsets.UTF_8)).substring(0,32);
        boolean exists=platform.db.read(c->one(c,"SELECT id FROM collab_projects WHERE id=?",id)!=null);
        SharedModel.Model initial=exists?null:new SharedModel.Model(volume.dims());
        PackedSnapshot packed;
        try{packed=initial==null?null:new PackedSnapshot(Nifti.gzipZeros((long)volume.count()*2),Nifti.gzipZeros((long)volume.count()*4),pack(initial.authors),pack(initial.regions));}
        catch(Exception error){throw new IllegalStateException("无法创建空白标注。",error);}
        return encodeState(write(c->{
            platform.requireRead(user,dataset);
            if(one(c,"SELECT id FROM collab_projects WHERE id=?",id)==null){
                List<Map<String,Object>> labels=initialLabels(user);String name=String.valueOf(source.metadata().getOrDefault("name","影像.nii"));
                exec(c,"INSERT INTO collab_projects(id,dataset,fingerprint,count,header,dims,little,name,labels) VALUES(?,?,?,?,?,?,?,?,?)",id,dataset,fingerprint,volume.count(),volume.header(),json(volume.dims()),volume.littleEndian()?1:0,name,json(labels));
                Project p=project(c,id);
                storeSnapshot(c,p,packed);models.put(id,new Cached(0,initial));encodedMasks.put(id,new EncodedMask(0,b64(packed.mask)));trimModels();
            }
            return state(c,project(c,id),null,user);
        }));
    }

    public record NativeExport(WorkbenchModel model,String project,long revision,int parallelRegions){}
    public NativeExport nativeExport(Auth.User user,String dataset,String fingerprint,Long requested){
        platform.requireRead(user,dataset);
        return platform.db.read(c->{
            Map<String,Object> found=one(c,"SELECT id FROM collab_projects WHERE dataset=? AND fingerprint=?",dataset,fingerprint);if(found==null)return null;
            Project p=readable(c,user,(String)found.get("id"));long target=requested==null?p.revision:requested;if(target<0||target>p.revision)throw new Failure(404,"旧版修订不存在。");
            State source=readState(c,p,target);SharedModel.Model old=source.model;WorkbenchModel result=WorkbenchModel.empty(p.count,p.name);result.layers.clear();result.manifest.withArray("masks").removeAll();
            Map<Integer,String> ids=new LinkedHashMap<>();
            for(Map<String,Object> label:source.labels){int number=((Number)label.get("id")).intValue();if(number==0)continue;String id="legacy-"+number;ids.put(number,id);ObjectNode def=result.manifest.withArray("masks").addObject();def.put("id",id);def.put("name",String.valueOf(label.get("name")));def.put("color",String.valueOf(label.get("color")));def.putNull("threshold");def.put("revision",target);result.layers.put(id,new WorkbenchModel.Layer());result.created.put("version:masks/"+id,target);}
            java.util.function.BiConsumer<Integer,String> add=(index,author)->{int value=old.mask[index];String mask=ids.get(value);if(mask==null||value==0)return;WorkbenchModel.Layer layer=result.layers.get(mask);layer.authors.computeIfAbsent(author,key->new java.util.BitSet()).set(index);layer.union.set(index);};
            for(int i=0;i<old.mask.length;i++)if(old.mask[i]!=0){String owner=primaryAuthor(old,i);add.accept(i,owner==null?"legacy-import":owner);}
            JsonNode agreed=platform.mapper.valueToTree(claims(c,p,target,old));for(JsonNode row:agreed){int index=row.get(0).asInt();for(JsonNode author:row.get(1))add.accept(index,author.asText());}
            for(SharedModel.Region region:old.regions)for(SharedModel.Annotation annotation:region.annotations)for(int[] value:annotation.values){String mask=ids.get(value[1]);if(mask==null||value[1]==0)continue;WorkbenchModel.Layer layer=result.layers.get(mask);layer.authors.computeIfAbsent(annotation.author,key->new java.util.BitSet()).set(value[0]);layer.union.set(value[0]);}
            ObjectNode legacy=result.manifest.putObject("legacySource");legacy.put("project",p.id);legacy.put("revision",target);legacy.put("parallelRegions",old.regions.size());
            return new NativeExport(result,p.id,target,old.regions.size());
        });
    }
    private boolean nativeOnly(String dataset){return platform.tableExists("wb_projects")&&platform.db.read(c->one(c,"SELECT p.id FROM wb_projects p JOIN datasets d ON d.id=p.dataset AND d.fingerprint=p.fingerprint WHERE d.id=?",dataset)!=null);}
    private Map<String,Object> mutate(String id,Auth.User user,String action,JsonNode body) {
        Map<String,Object> result=write(c->{
            Project p=project(c,id);platform.requireWrite(user,p.dataset);if(nativeOnly(p.dataset))throw new Failure(423,"该数据集已接入标注工作台，旧编辑入口只读。");
            if(p.status.equals("finalized")&&!action.equals("reopen"))throw new Failure(423,"该工程已定稿，标注已锁定。");
            if(!List.of("operations","labels").contains(action))platform.requireLeader(user,p.dataset);
            if(List.of("resolve","finalize","reopen").contains(action)&&number(body,"revision")!=p.revision)throw new Failure(409,"共享成果已有新操作，请刷新后再审定。");
            String op=body.hasNonNull("op")?text(body,"op"):UUID.randomUUID().toString();
            if(!validId(op))throw new Failure(400,"操作编号无效。");
            Map<String,Object> old=one(c,"SELECT revision,author,details FROM collab_events WHERE project=? AND op=?",id,op);
            if(old!=null){if(!user.id().equals(old.get("author")))throw new Failure(409,"此操作编号属于另一作者。");Map<String,Object> duplicate=map("revision",((Number)old.get("revision")).longValue(),"duplicate",true);JsonNode details=unpack((byte[])old.get("details"));if(action.equals("labels")&&details.has("labelId"))duplicate.put("label",platform.mapper.convertValue(findLabel(details.get("labels"),details.get("labelId").asInt()),Map.class));return duplicate;}
            SharedModel.Model model=readModel(c,p);claims(c,p,p.revision,model);SharedModel.Author author=new SharedModel.Author(user.id(),user.name());
            if(action.equals("labels")){
                List<Map<String,Object>> labels=copyLabels(p.labels);Map<String,Object> label=null;
                if(body.has("id")){long labelId=number(body,"id");for(Map<String,Object> row:labels)if(((Number)row.get("id")).longValue()==labelId)label=row;if(label==null)throw new Failure(400,"标签不存在。");}
                else {int next=labels.stream().mapToInt(l->((Number)l.get("id")).intValue()).max().orElse(0)+1;if(labels.size()>=64||next>65535)throw new Failure(400,"标签数量已达上限。");String[] colors={"#fb9f67","#859dff","#ed78b6","#e5d46f","#74c5f4"};label=newLabel(next,"标注 "+next,colors[Math.floorMod(next-2,colors.length)],user);labels.add(label);}
                if(body.has("name")){String name=text(body,"name").trim();if(name.isEmpty()||name.length()>60)throw new Failure(400,"标签名称无效。");label.put("name",name);}
                if(body.has("color")){String color=text(body,"color");if(!color.matches("#[a-fA-F0-9]{6}"))throw new Failure(400,"颜色无效。");label.put("color",color);}
                long revision=saveEvent(c,p,author,op,body.has("id")?"标签设置":"新增标签",model,List.of(),List.of(),null,null,labels,p.status,map("labelId",label.get("id")));
                return map("revision",revision,"label",label);
            }
            if(action.equals("operations")){
                if(!body.has("op"))throw new Failure(400,"操作编号无效。");
                if(body.has("key")&&!text(body,"key").startsWith(user.id()+":"+id+":"))throw new Failure(401,"操作属于另一账户。");
                long base=number(body,"baseRevision");if(base<0||base>p.revision)throw new Failure(400,"客户端修订号无效。");
                boolean review=body.path("review").asBoolean(false);if(review)platform.requireLeader(user,p.dataset);
                String patch=text(body,"patch");List<int[]> entries=decodePatch(patch,p.count);Set<Integer> allowed=new HashSet<>();allowed.add(0);for(Map<String,Object> label:p.labels)allowed.add(((Number)label.get("id")).intValue());
                for(int[] entry:entries)if(!allowed.contains(entry[1])||!allowed.contains(entry[2]))throw new Failure(400,"编辑包含未知标签。");
                SharedModel.ApplyResult applied=SharedModel.apply(model,author,entries,review,review?Map.of():recentAgreements(c,p,author,model,entries));
                List<int[]> canonical=new ArrayList<>(entries.size());for(int[] entry:entries)canonical.add(new int[]{entry[0],entry[1],model.mask[entry[0]]});
                String kind=review?"组长最终修改":body.path("kind").asText().equals("undo")?"撤销":body.path("kind").asText().equals("redo")?"重做":"标注";
                long revision=saveEvent(c,p,author,op,kind,model,applied.applied,applied.ownerUpdates,patch,encodePatch(canonical),p.labels,p.status,Map.of());
                return map("revision",revision,"parallelCount",applied.conflictCount,"protectedCount",applied.protectedCount);
            }
            if(action.equals("resolve")){
                Long requestedLabel=body.has("label")?number(body,"label"):null;
                if(requestedLabel!=null&&(requestedLabel<0||requestedLabel>65535))throw new Failure(400,"标签无效。");
                Integer label=requestedLabel==null?null:requestedLabel.intValue();if(label!=null&&label!=0&&p.labels.stream().noneMatch(l->((Number)l.get("id")).intValue()==label))throw new Failure(400,"标签无效。");
                SharedModel.ApplyResult applied=SharedModel.resolve(model,author,text(body,"regionId"),body.path("annotationId").asText(null),label);
                return map("revision",saveEvent(c,p,author,op,"组长审定并列标注",model,applied.applied,applied.ownerUpdates,null,null,p.labels,p.status,Map.of()));
            }
            if(action.equals("finalize")){
                if(!model.regions.isEmpty())throw new Failure(409,"仍有并列标注未审定，暂不能定稿。");
                String now=Instant.now().toString();return map("revision",saveEvent(c,p,author,op,"组长定稿",model,List.of(),List.of(),null,null,p.labels,"finalized",map("finalizedBy",user.name(),"finalizedAt",now,"finalRevision",p.revision+1)));
            }
            if(!p.status.equals("finalized"))throw new Failure(400,"工程尚未定稿。");
            return map("revision",saveEvent(c,p,author,op,"组长重新开放",model,List.of(),List.of(),null,null,p.labels,"editing",Map.of()));
        });
        long revision=((Number)result.get("revision")).longValue();Map<String,Object> delta=platform.db.read(c->delta(c,id,revision));
        result.put("delta",delta);if(!Boolean.TRUE.equals(result.get("duplicate")))broadcast(id,delta);
        return result;
    }

    /** Called only after the platform completion transaction commits. */
    public void datasetCompleted(String dataset) {
        List<Map<String,Object>> deltas=write(c->{List<Map<String,Object>> result=new ArrayList<>();for(Map<String,Object> row:all(c,"SELECT id FROM collab_projects WHERE dataset=?",dataset)){
            Project p=project(c,(String)row.get("id"));if(p.status.equals("finalized"))continue;
            SharedModel.Model model=readModel(c,p);claims(c,p,p.revision,model);String now=Instant.now().toString();long revision=saveEvent(c,p,new SharedModel.Author("system","任务完成"),"completed-"+dataset,"任务完成",model,List.of(),List.of(),null,null,p.labels,"finalized",map("finalizedBy","任务完成","finalizedAt",now,"finalRevision",p.revision+1));result.add(delta(c,p.id,revision));
        }return result;});
        for(Map<String,Object> event:deltas)broadcast((String)event.get("projectId"),event);
        for(Peer peer:peers.values())if(peer.dataset.equals(dataset))send(peer,map("type","access","datasetId",dataset,"canWrite",false,"status","completed"));
    }

    private Project readable(Connection c,Auth.User user,String id)throws Exception {Project p=project(c,id);platform.requireRead(user,p.dataset);return p;}
    private boolean completed(String dataset){return "completed".equals(platform.dataset(dataset).get("status"));}
    private boolean canWrite(Auth.User user,String dataset){if(nativeOnly(dataset))return false;try{platform.requireWrite(user,dataset);return true;}catch(HttpResponseException error){return false;}}
    private Map<String,Object> state(Connection c,Project p,Long revision,Auth.User user)throws Exception {
        long target=revision==null?p.revision:revision;if(target<0||target>p.revision)throw new Failure(404,"修订记录不存在。");State state=readState(c,p,target);SharedModel.Model model=state.model;
        byte[] bits=new byte[(model.mask.length+7)/8];int ownerCode=0;for(int n=0;n<model.authors.size();n++)if(model.authors.get(n).id.equals(user.id()))ownerCode=n+1;
        if(ownerCode!=0)for(int i=0;i<model.mask.length;i++)if(model.mask[i]!=0&&model.owners[i]==ownerCode)bits[i>>>3]|=(byte)(1<<(i&7));
        String taskStatus=String.valueOf(platform.dataset(p.dataset).get("status"));boolean locked=taskStatus.equals("completed");
        return map("id",p.id,"datasetId",p.dataset,"fingerprint",p.fingerprint,"name",p.name,"revision",target,"latestRevision",p.revision,
                "mask",cachedMask(p.id,target,model),"ownershipAuthor",user.id(),"ownedVoxels",bits,"regions",platform.mapper.valueToTree(model.regions),"claims",claims(c,p,target,model),"labels",state.labels,
                "status",state.status,"datasetStatus",taskStatus,"canWrite",!locked&&state.status.equals("editing")&&canWrite(user,p.dataset),
                "finalizedBy",state.finalizedBy,"finalizedAt",state.finalizedAt,"finalRevision",state.finalRevision);
    }
    private Object cachedMask(String id,long revision,SharedModel.Model model){
        EncodedMask cached=encodedMasks.get(id);return cached!=null&&cached.revision==revision?cached.mask:Nifti.u16Bytes(model.mask);
    }
    /** The raw bytes are a consistent revision captured under the lock; gzip happens after releasing it. */
    private Map<String,Object> encodeState(Map<String,Object> state){
        if(state.get("mask") instanceof byte[] raw){
            String mask=b64(Nifti.gzip(raw)),id=(String)state.get("id");long revision=((Number)state.get("revision")).longValue();state.put("mask",mask);
            encodedMasks.compute(id,(key,old)->old==null||old.revision<=revision?new EncodedMask(revision,mask):old);
            if(encodedMasks.size()>4)encodedMasks.keySet().stream().filter(key->!key.equals(id)).findFirst().ifPresent(encodedMasks::remove);
        }
        if(state.get("ownedVoxels") instanceof byte[] raw)state.put("ownedVoxels",b64(Nifti.gzip(raw)));
        return state;
    }
    private Map<String,Object> provenance(Connection c,Project p,long index,long revision,boolean historical)throws Exception {
        if(index<0||index>=p.count)throw new Failure(400,"体素索引无效。");if(!historical&&revision!=p.revision)throw new Failure(409,"标注修订已更新，请重新查询作者。");if(revision<0||revision>p.revision)throw new Failure(404,"修订记录不存在。");
        State state=readState(c,p,revision);SharedModel.Model model=state.model;int i=(int)index,code=model.owners[i];SharedModel.Author author=code>0&&code<=model.authors.size()?model.authors.get(code-1):null;List<Map<String,Object>> annotations=new ArrayList<>();
        for(SharedModel.Region region:model.regions)if(region.indices.contains(i))for(SharedModel.Annotation row:region.annotations)for(int[] entry:row.values)if(entry[0]==i){annotations.add(map("author",row.author,"name",row.name,"label",entry[1]));break;}
        return map("projectId",p.id,"index",i,"revision",revision,"label",model.mask[i],"author",author,"annotations",annotations);
    }
    private State readState(Connection c,Project p,long target)throws Exception {
        if(target==p.revision)return new State(readModel(c,p),p.labels,p.status,p.finalizedBy,p.finalizedAt,p.finalRevision);
        Map<String,Object> snapshot=one(c,"SELECT * FROM collab_snapshots WHERE project=? AND revision<=? ORDER BY revision DESC LIMIT 1",p.id,target);
        if(snapshot==null)throw new Failure(404,"修订记录不存在。");SharedModel.Model model=fromSnapshot(snapshot,p);List<Map<String,Object>> labels=parseLabels((String)snapshot.get("labels"));String status=(String)snapshot.get("status"),by=(String)snapshot.get("finalized_by"),at=(String)snapshot.get("finalized_at");Long finalRevision=nullableLong(snapshot.get("final_revision"));
        for(Map<String,Object> row:all(c,"SELECT details FROM collab_events WHERE project=? AND revision>? AND revision<=? ORDER BY revision",p.id,snapshot.get("revision"),target)){
            JsonNode event=unpack((byte[])row.get("details"));replay(model,event);labels=platform.mapper.convertValue(event.get("labels"),LABELS);status=event.path("status").asText();if(event.hasNonNull("finalRevision")){by=event.path("finalizedBy").asText();at=event.path("finalizedAt").asText();finalRevision=event.path("finalRevision").asLong();}
        }
        return new State(model,labels,status,by,at,finalRevision);
    }
    private SharedModel.Model readModel(Connection c,Project p)throws Exception {
        Cached cached=models.get(p.id);if(cached!=null&&cached.revision==p.revision)return cached.model;
        SharedModel.Model model;long from;
        if(cached!=null&&cached.revision<p.revision){model=cached.model;from=cached.revision;}
        else {Map<String,Object> row=one(c,"SELECT * FROM collab_snapshots WHERE project=? ORDER BY revision DESC LIMIT 1",p.id);model=fromSnapshot(row,p);from=((Number)row.get("revision")).longValue();}
        for(Map<String,Object> row:all(c,"SELECT details FROM collab_events WHERE project=? AND revision>? AND revision<=? ORDER BY revision",p.id,from,p.revision))replay(model,unpack((byte[])row.get("details")));
        models.put(p.id,new Cached(p.revision,model));trimModels();return model;
    }
    private SharedModel.Model fromSnapshot(Map<String,Object> row,Project p)throws Exception {
        int[] mask=Nifti.gunzipU16((byte[])row.get("mask")),owners=Nifti.gunzipU32((byte[])row.get("owners"));
        if(mask.length!=p.count||owners.length!=p.count)throw new IllegalStateException("Stored project geometry mismatch");
        return new SharedModel.Model(mask,owners,p.dims.clone(),platform.mapper.readValue(Nifti.gunzip((byte[])row.get("authors")),AUTHORS),platform.mapper.readValue(Nifti.gunzip((byte[])row.get("regions")),REGIONS));
    }
    private void replay(SharedModel.Model model,JsonNode event){
        for(JsonNode row:event.path("applied"))model.mask[row.get(0).asInt()]=row.get(2).asInt();for(JsonNode row:event.path("ownerUpdates"))model.owners[row.get(0).asInt()]=row.get(1).asInt();
        model.authors=platform.mapper.convertValue(event.get("authors"),AUTHORS);model.regions=platform.mapper.convertValue(event.get("regions"),REGIONS);
    }
    private void trimModels(){long bytes=0;for(Cached model:models.values())bytes+=(long)model.model.mask.length*8;Iterator<Map.Entry<String,Cached>> iterator=models.entrySet().iterator();while(models.size()>1&&(models.size()>4||bytes>modelCacheBudget)){Cached old=iterator.next().getValue();bytes-=(long)old.model.mask.length*8;iterator.remove();}}
    private PackedSnapshot packSnapshot(SharedModel.Model model){
        try{return new PackedSnapshot(Nifti.gzipU16(model.mask),Nifti.gzipU32(model.owners),pack(model.authors),pack(model.regions));}
        catch(Exception error){throw new IllegalStateException("无法生成快照。",error);}
    }
    private void storeSnapshot(Connection c,Project p,PackedSnapshot packed)throws Exception {
        exec(c,"INSERT OR REPLACE INTO collab_snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?)",p.id,p.revision,packed.mask,packed.owners,packed.authors,packed.regions,json(p.labels),p.status,p.finalizedBy,p.finalizedAt,p.finalRevision);
        // Keep revision zero for arbitrary historical replay plus the newest live checkpoint.
        if(p.revision!=0)exec(c,"DELETE FROM collab_snapshots WHERE project=? AND revision<>0 AND revision<>?",p.id,p.revision);
    }
    private void checkpoint(String id){
        if(!checkpointPending.add(id))return;
        checkpoints.execute(()->{
            try{
                // Capture only the compressed base and durable event journal under the lock.
                // Reconstructing the checkpoint outside it avoids copying two full CT-sized arrays while editors wait.
                Checkpoint captured=platform.db.read(c->{
                    Project p=project(c,id);
                    Map<String,Object> snapshot=one(c,"SELECT * FROM collab_snapshots WHERE project=? AND revision<=? ORDER BY revision DESC LIMIT 1",id,p.revision);
                    return new Checkpoint(p,snapshot,all(c,"SELECT details FROM collab_events WHERE project=? AND revision>? AND revision<=? ORDER BY revision",id,snapshot.get("revision"),p.revision));
                });
                SharedModel.Model restored=fromSnapshot(captured.snapshot,captured.project);
                for(Map<String,Object> event:captured.events)replay(restored,unpack((byte[])event.get("details")));
                PackedSnapshot packed=packSnapshot(restored);
                platform.db.transaction(c->{storeSnapshot(c,captured.project,packed);return null;});
            }catch(Exception error){System.err.println("Checkpoint deferred: "+error.getClass().getSimpleName());}
            finally{checkpointPending.remove(id);}
        });
    }
    private static Set<Integer> regionPoints(SharedModel.Model model){Set<Integer> points=new HashSet<>();for(SharedModel.Region region:model.regions)points.addAll(region.indices);return points;}
    private static String primaryAuthor(SharedModel.Model model,int index){int code=model.owners[index];return code>0&&code<=model.authors.size()?model.authors.get(code-1).id:null;}
    private static List<Object> claimRows(Map<Integer,LinkedHashSet<String>> values){
        List<Object> result=new ArrayList<>(values.size());for(var entry:values.entrySet())if(entry.getValue().size()>1)result.add(List.of(entry.getKey(),List.copyOf(entry.getValue())));return result;
    }
    private Map<Integer,LinkedHashSet<String>> readClaims(JsonNode rows){
        Map<Integer,LinkedHashSet<String>> result=new LinkedHashMap<>();for(JsonNode row:rows){LinkedHashSet<String> authors=new LinkedHashSet<>();for(JsonNode author:row.path(1))authors.add(author.asText());if(authors.size()>1)result.put(row.path(0).asInt(),authors);}return result;
    }
    /** Match recentAgreements' latest-intent/primary-write boundary without copying a volume per author. */
    private Map<Integer,LinkedHashSet<String>> scanClaims(Connection c,Project p,long target,SharedModel.Model model,Set<Integer> wanted,JsonNode newest,String newestAuthor)throws Exception {
        Set<Integer> regions=regionPoints(model);BitSet closed=new BitSet();Map<String,Set<Integer>> seen=new HashMap<>();Map<Integer,LinkedHashSet<String>> found=new LinkedHashMap<>();
        class Scan {
            boolean relevant(int index){return index>=0&&index<model.mask.length&&model.mask[index]!=0&&!regions.contains(index)&&(wanted==null||wanted.contains(index))&&!closed.get(index);}
            void event(String author,JsonNode event){
                if(event.has("intent")){ByteBuffer patch=ByteBuffer.wrap(Base64.getDecoder().decode(event.get("intent").asText())).order(ByteOrder.LITTLE_ENDIAN);while(patch.remaining()>=8){int index=patch.getInt();patch.getShort();int after=Short.toUnsignedInt(patch.getShort());if(!relevant(index)||Objects.equals(author,primaryAuthor(model,index))||!seen.computeIfAbsent(author,ignored->new HashSet<>()).add(index))continue;if(after==model.mask[index])found.computeIfAbsent(index,ignored->new LinkedHashSet<>()).add(author);}}
                for(JsonNode row:event.path("applied")){int index=row.path(0).asInt();if(relevant(index)&&Objects.equals(author,primaryAuthor(model,index))&&row.path(2).asInt()==model.mask[index])closed.set(index);}
            }
        }
        Scan scan=new Scan();if(newest!=null)scan.event(newestAuthor,newest);
        try(PreparedStatement query=c.prepareStatement("SELECT author,details FROM collab_events WHERE project=? AND revision<=? ORDER BY revision DESC")){query.setString(1,p.id);query.setLong(2,Math.min(target,p.revision));try(ResultSet rows=query.executeQuery()){while(rows.next()){scan.event(rows.getString("author"),unpack(rows.getBytes("details")));if(wanted!=null&&wanted.stream().allMatch(closed::get))break;}}}
        Map<Integer,LinkedHashSet<String>> result=new LinkedHashMap<>();for(var entry:found.entrySet()){String owner=primaryAuthor(model,entry.getKey());if(owner==null)continue;LinkedHashSet<String> authors=new LinkedHashSet<>();authors.add(owner);authors.addAll(entry.getValue());if(authors.size()>1)result.put(entry.getKey(),authors);}return result;
    }
    private List<Object> claims(Connection c,Project p,long target,SharedModel.Model model)throws Exception {
        ClaimState cached=claimStates.get(p.id);if(cached!=null&&cached.revision==target)return claimRows(cached.values);
        Map<String,Object> latest=target==0?null:one(c,"SELECT details FROM collab_events WHERE project=? AND revision=?",p.id,target);JsonNode details=latest==null?null:unpack((byte[])latest.get("details"));
        Map<Integer,LinkedHashSet<String>> values=details!=null&&details.has("claims")?readClaims(details.get("claims")):scanClaims(c,p,target,model,null,null,null);
        if(target==p.revision){claimStates.put(p.id,new ClaimState(target,values,regionPoints(model)));while(claimStates.size()>4)claimStates.remove(claimStates.keySet().iterator().next());}
        return claimRows(values);
    }
    /** Common paint/erase updates avoid journal scans; only a region collapse/review needs legacy lookup. */
    private List<Object> advanceClaims(Connection c,Project p,long revision,SharedModel.Model model,SharedModel.Author author,JsonNode details)throws Exception {
        ClaimState previous=claimStates.get(p.id);if(previous==null||previous.revision!=p.revision){Map<Integer,LinkedHashSet<String>> rebuilt=scanClaims(c,p,revision,model,null,details,author.id);claimStates.put(p.id,new ClaimState(revision,rebuilt,regionPoints(model)));return claimRows(rebuilt);}
        Map<Integer,LinkedHashSet<String>> values=new LinkedHashMap<>();for(var entry:previous.values.entrySet())values.put(entry.getKey(),new LinkedHashSet<>(entry.getValue()));
        Set<Integer> regions=regionPoints(model),recheck=new HashSet<>(previous.regionPoints);recheck.removeAll(regions);
        Set<Integer> changed=new HashSet<>();for(JsonNode row:details.path("applied"))changed.add(row.path(0).asInt());
        if(details.has("intent")){ByteBuffer patch=ByteBuffer.wrap(Base64.getDecoder().decode(details.get("intent").asText())).order(ByteOrder.LITTLE_ENDIAN);while(patch.remaining()>=8){int index=patch.getInt();patch.getShort();int after=Short.toUnsignedInt(patch.getShort());if(regions.contains(index)||model.mask[index]==0){values.remove(index);continue;}String owner=primaryAuthor(model,index);if(after==0){LinkedHashSet<String> authors=values.get(index);if(authors!=null){authors.remove(author.id);if(owner!=null)authors.add(owner);if(authors.size()<2)values.remove(index);}}else if(changed.contains(index)){values.remove(index);}else if(after==model.mask[index]&&!Objects.equals(owner,author.id)&&owner!=null){LinkedHashSet<String> authors=values.computeIfAbsent(index,ignored->{LinkedHashSet<String> result=new LinkedHashSet<>();result.add(owner);return result;});authors.add(author.id);}}}
        else if(!changed.isEmpty())recheck.addAll(changed);
        for(int index:regions)values.remove(index);
        if(!recheck.isEmpty()){for(int index:recheck)values.remove(index);values.putAll(scanClaims(c,p,revision,model,recheck,details,author.id));}
        for(var entry:values.entrySet()){String owner=primaryAuthor(model,entry.getKey());if(owner!=null){LinkedHashSet<String> ordered=new LinkedHashSet<>();ordered.add(owner);ordered.addAll(entry.getValue());entry.setValue(ordered);}}
        claimStates.put(p.id,new ClaimState(revision,values,regions));while(claimStates.size()>4)claimStates.remove(claimStates.keySet().iterator().next());return claimRows(values);
    }
    private long saveEvent(Connection c,Project p,SharedModel.Author author,String op,String kind,SharedModel.Model model,List<int[]> applied,List<int[]> ownerUpdates,String intent,String canonical,List<Map<String,Object>> labels,String status,Map<String,Object> extra)throws Exception {
        long revision=p.revision+1;Map<String,Object> details=map("shared",true,"applied",applied,"ownerUpdates",ownerUpdates,"regions",model.regions,"authors",model.authors,"labels",labels,"status",status);if(intent!=null)details.put("intent",intent);if(canonical!=null)details.put("canonical",canonical);details.putAll(extra);
        details.put("claims",advanceClaims(c,p,revision,model,author,platform.mapper.valueToTree(details)));
        exec(c,"INSERT INTO collab_events VALUES(?,?,?,?,?,?,?,?)",p.id,revision,op,author.id,author.name,kind,Instant.now().toString(),pack(details));
        exec(c,"UPDATE collab_projects SET revision=?,labels=?,status=?,finalized_by=?,finalized_at=?,final_revision=? WHERE id=?",revision,json(labels),status,extra.getOrDefault("finalizedBy",p.finalizedBy),extra.getOrDefault("finalizedAt",p.finalizedAt),extra.getOrDefault("finalRevision",p.finalRevision),p.id);
        models.put(p.id,new Cached(revision,model));trimModels();if(revision%128==0)checkpoint(p.id);return revision;
    }
    private Map<Integer,SharedModel.Author> recentAgreements(Connection c,Project p,SharedModel.Author person,SharedModel.Model model,List<int[]> entries)throws Exception {
        Set<Integer> regionPoints=new HashSet<>();for(SharedModel.Region region:model.regions)regionPoints.addAll(region.indices);Set<Integer> wanted=new HashSet<>();
        for(int[] entry:entries){int i=entry[0],owner=model.owners[i];if(model.mask[i]!=entry[2]&&owner>0&&owner<=model.authors.size()&&model.authors.get(owner-1).id.equals(person.id)&&!regionPoints.contains(i))wanted.add(i);}
        Map<Integer,SharedModel.Author> found=new HashMap<>();if(wanted.isEmpty())return found;Set<String> seen=new HashSet<>();
        try(PreparedStatement query=c.prepareStatement("SELECT author,name,details FROM collab_events WHERE project=? ORDER BY revision DESC")){query.setString(1,p.id);try(ResultSet rows=query.executeQuery()){while(rows.next()&&!wanted.isEmpty()){
            String author=rows.getString("author"),name=rows.getString("name");JsonNode event=unpack(rows.getBytes("details"));
            if(event.has("intent")){byte[] bytes=Base64.getDecoder().decode(event.get("intent").asText());ByteBuffer patch=ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);while(patch.remaining()>=8){int i=patch.getInt();patch.getShort();int after=Short.toUnsignedInt(patch.getShort());if(!wanted.contains(i)||!seen.add(author+":"+i))continue;if(!author.equals(person.id)&&after==model.mask[i]){found.put(i,new SharedModel.Author(author,name));wanted.remove(i);}}}
            if(author.equals(person.id))for(JsonNode entry:event.path("applied"))if(entry.get(2).asInt()==model.mask[entry.get(0).asInt()])wanted.remove(entry.get(0).asInt());
        }}}return found;
    }

    private Map<String,Object> delta(Connection c,String id,long revision)throws Exception {
        Map<String,Object> row=one(c,"SELECT * FROM collab_events WHERE project=? AND revision=?",id,revision);if(row==null)return null;JsonNode details=unpack((byte[])row.get("details"));List<List<Object>> owners=new ArrayList<>();
        for(JsonNode update:details.path("ownerUpdates")){int code=update.get(1).asInt();JsonNode author=code>0&&code<=details.path("authors").size()?details.get("authors").get(code-1):null;List<Object> entry=new ArrayList<>();entry.add(update.get(0).asInt());entry.add(author==null?null:author.path("id").asText());owners.add(entry);}
        String patch=details.has("canonical")?details.get("canonical").asText():encodePatch(platform.mapper.convertValue(details.path("applied"),new TypeReference<List<int[]>>(){}));
        Map<String,Object> result=map("type","delta","projectId",id,"revision",revision,"op",row.get("op"),"author",row.get("author"),"name",row.get("name"),"kind",row.get("kind"),"time",row.get("time"),"patch",patch,"owners",owners,"regions",details.get("regions"),"labels",details.get("labels"),"status",details.path("status").asText());
        if(details.has("claims"))result.put("claims",details.get("claims"));
        for(String key:List.of("finalizedBy","finalizedAt","finalRevision"))if(details.has(key))result.put(key,platform.mapper.convertValue(details.get(key),Object.class));return result;
    }
    private Map<String,Object> updates(Connection c,Project p,long after)throws Exception {if(after<0||after>p.revision)return map("reset",true,"revision",p.revision);List<Map<String,Object>> rows=all(c,"SELECT revision FROM collab_events WHERE project=? AND revision>? ORDER BY revision LIMIT 128",p.id,after);List<Map<String,Object>> events=new ArrayList<>();for(Map<String,Object> row:rows)events.add(delta(c,p.id,((Number)row.get("revision")).longValue()));long last=rows.isEmpty()?after:((Number)rows.get(rows.size()-1).get("revision")).longValue();return map("revision",p.revision,"events",events,"more",last<p.revision);}
    private List<Map<String,Object>> history(Connection c,String id)throws Exception {return all(c,"SELECT revision,op,author,name,kind,time FROM collab_events WHERE project=? ORDER BY revision DESC LIMIT 100",id);}
    private Map<String,Object> archive(Connection c,Project p,Long revision)throws Exception {
        long target=revision==null?p.revision:revision;if(target<0||target>p.revision)throw new Failure(404,"修订记录不存在。");State state=readState(c,p,target);byte[] nifti=Nifti.export(new Nifti.Volume(p.header,p.dims,p.count,p.little),state.model.mask);String parallel=state.model.regions.isEmpty()?null:"parallel-annotations.json";
        Map<String,byte[]> files=new LinkedHashMap<>();files.put("segmentation.nii",nifti);files.put("labels.json",json(map("version",1,"segments",state.labels)).getBytes(StandardCharsets.UTF_8));files.put("manifest.json",json(map("format","deepmark-export-1","projectId",p.id,"datasetId",p.dataset,"fingerprint",p.fingerprint,"revision",target,"status",state.status,"segmentationFile","segmentation.nii","labelsFile","labels.json","parallelFile",parallel)).getBytes(StandardCharsets.UTF_8));
        files.put("README.txt","Deepmark 标注导出包\nsegmentation.nii：NIfTI-1 分割标签；0 为背景。\nlabels.json：标签编号、名称和颜色。\nmanifest.json：影像指纹及修订信息。\nparallel-annotations.json（如有）：局部并列标注意见，请与主标签图一并保留。\n本包不包含原始影像。\n".getBytes(StandardCharsets.UTF_8));
        if(parallel!=null)files.put(parallel,json(map("format","deepmark-parallel-1","projectId",p.id,"revision",target,"primaryFile","segmentation.nii","parallelRegions",state.model.regions)).getBytes(StandardCharsets.UTF_8));
        ByteArrayOutputStream bytes=new ByteArrayOutputStream();try(ZipOutputStream zip=new ZipOutputStream(bytes,StandardCharsets.UTF_8)){for(Map.Entry<String,byte[]> file:files.entrySet()){ZipEntry entry=new ZipEntry(file.getKey());entry.setTime(946684800000L);zip.putNextEntry(entry);zip.write(file.getValue());zip.closeEntry();}}
        return map("bytes",bytes.toByteArray(),"revision",target);
    }

    private void broadcast(String project,Map<String,Object> event){if(event==null)return;boolean removed=false;for(Peer peer:peers.values())if(peer.project.equals(project)){
        if(peerUser(peer)!=null)send(peer,event);else removed=true;
    }if(removed)broadcastPresence(project);}
    private Auth.User peerUser(Peer peer){
        try{Auth.User user=platform.auth.fromCookie(peer.cookie);if(user==null||!user.id().equals(peer.userId))throw new Failure(401,"Session changed");platform.requireRead(user,peer.dataset);return user;}
        catch(RuntimeException error){peers.remove(peer.context.sessionId(),peer);peer.context.closeSession(1008,"Project access revoked");return null;}
    }
    private Map<String,Object> presence(String project){
        Map<String,Map<String,Object>> members=new java.util.TreeMap<>();
        for(Peer peer:peers.values())if(peer.project.equals(project)){Auth.User user=peerUser(peer);if(user!=null)members.put(user.id(),map("id",user.id(),"name",user.name(),"role",user.role()));}
        return map("projectId",project,"members",new ArrayList<>(members.values()));
    }
    private void broadcastPresence(String project){Map<String,Object> event=presence(project);event.put("type","presence");for(Peer peer:peers.values())if(peer.project.equals(project))send(peer,event);}
    private void peerLeft(String session){Peer peer=peers.remove(session);if(peer!=null)broadcastPresence(peer.project);}
    private void refreshPresence(){try{Set<String> projects=new HashSet<>();for(Peer peer:peers.values())projects.add(peer.project);for(String project:projects)broadcastPresence(project);}catch(RuntimeException ignored){/* A transient database error must not terminate future access checks. */}}
    private void send(Peer peer,Object value){synchronized(peer){try{peer.context.send(platform.mapper.writeValueAsString(value));}catch(Exception error){peers.remove(peer.context.sessionId());peer.context.closeSession(1011,"Connection failed");}}}
    private <T>T write(Database.SqlFunction<T> action){try{return platform.db.transaction(action);}catch(RuntimeException error){platform.db.read(c->{models.clear();claimStates.clear();return null;});throw error;}}
    private Project project(Connection c,String id)throws Exception {
        if(id==null||!id.matches("[a-f0-9]{32}"))throw new Failure(404,"共享工程不存在。");Map<String,Object> p=one(c,"SELECT * FROM collab_projects WHERE id=?",id);if(p==null)throw new Failure(404,"共享工程不存在。");
        return new Project(id,(String)p.get("dataset"),(String)p.get("fingerprint"),((Number)p.get("count")).intValue(),(byte[])p.get("header"),platform.mapper.readValue((String)p.get("dims"),int[].class),((Number)p.get("little")).intValue()!=0,(String)p.get("name"),parseLabels((String)p.get("labels")),((Number)p.get("revision")).longValue(),(String)p.get("status"),(String)p.get("finalized_by"),(String)p.get("finalized_at"),nullableLong(p.get("final_revision")));
    }
    private List<Map<String,Object>> parseLabels(String raw)throws Exception{return platform.mapper.readValue(raw,LABELS);}
    private List<Map<String,Object>> copyLabels(List<Map<String,Object>> labels){List<Map<String,Object>> result=new ArrayList<>();for(Map<String,Object> label:labels)result.add(new LinkedHashMap<>(label));return result;}
    private static Map<String,Object> newLabel(int id,String name,String color,Auth.User user){return map("id",id,"name",name,"color",color,"createdBy",map("id",user.id(),"name",user.name()),"createdAt",Instant.now().toString());}
    private static List<Map<String,Object>> initialLabels(Auth.User user){return new ArrayList<>(List.of(newLabel(1,"标注 1","#4ed1ad",user)));}
    private static JsonNode findLabel(JsonNode labels,int id){for(JsonNode label:labels)if(label.path("id").asInt()==id)return label;return null;}
    private Auth.User user(Context ctx){Auth.User user=platform.auth.require(ctx);String author=ctx.header("X-Deepmark-Author");if(author!=null&&!author.equals(user.id()))throw new Failure(401,"当前账户身份已变化，请重新登录。");return user;}
    private JsonNode body(Context ctx)throws Exception {String raw=ctx.body();if(raw.length()>MAX_MESSAGE)throw new Failure(413,"操作数据超过上限。");JsonNode value;try{value=platform.mapper.readTree(raw);}catch(java.io.IOException error){throw new Failure(400,"请求格式无效。");}if(value==null||!value.isObject())throw new Failure(400,"请求格式无效。");return value;}
    private static String text(JsonNode node,String key){JsonNode value=node==null?null:node.get(key);if(value==null||!value.isTextual())throw new Failure(400,"缺少有效字段："+key);return value.asText();}
    private static long number(JsonNode node,String key){JsonNode value=node.get(key);if(value==null||!value.isIntegralNumber()||!value.canConvertToLong())throw new Failure(400,"数值字段无效："+key);return value.asLong();}
    private static Long optionalLong(String value){if(value==null)return null;try{return Long.parseLong(value);}catch(NumberFormatException error){throw new Failure(400,"修订号或索引无效。");}}
    private static Long nullableLong(Object value){return value==null?null:((Number)value).longValue();}
    private static boolean validId(String id){return id!=null&&id.matches("[\\w-]{1,80}");}
    public static List<int[]> decodePatch(String encoded,int count){byte[] bytes;try{if(encoded.length()>((long)MAX_PATCH+2)/3*4)throw new Failure(413,"单次编辑超过同步上限。");bytes=Base64.getDecoder().decode(encoded);}catch(IllegalArgumentException error){throw new Failure(400,"编辑编码无效。");}if(bytes.length==0||bytes.length%8!=0||bytes.length>MAX_PATCH)throw new Failure(400,"单次编辑为空或超过同步上限。");List<int[]> entries=new ArrayList<>(bytes.length/8);ByteBuffer patch=ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);int previous=-1;while(patch.hasRemaining()){int index=patch.getInt(),before=Short.toUnsignedInt(patch.getShort()),after=Short.toUnsignedInt(patch.getShort());if(index<0||index>=count||index<=previous)throw new Failure(400,"体素索引越界或重复。");previous=index;entries.add(new int[]{index,before,after});}return entries;}
    public static String encodePatch(List<int[]> entries){ByteBuffer out=ByteBuffer.allocate(entries.size()*8).order(ByteOrder.LITTLE_ENDIAN);for(int[] row:entries)out.putInt(row[0]).putShort((short)row[1]).putShort((short)row[2]);return b64(out.array());}
    private byte[] pack(Object value)throws Exception{return Nifti.gzip(platform.mapper.writeValueAsBytes(value));}
    private JsonNode unpack(byte[] value)throws Exception{return platform.mapper.readTree(Nifti.gunzip(value));}
    private String json(Object value)throws Exception{return platform.mapper.writeValueAsString(value);}
    private static String b64(byte[] value){return Base64.getEncoder().encodeToString(value);}
    public static String sha256(byte[] bytes){try{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));}catch(Exception error){throw new IllegalStateException(error);}}
    private static int status(Exception error){return error instanceof Failure f?f.status:error instanceof SharedModel.Failure f?f.status:error instanceof HttpResponseException f?f.getStatus():error instanceof IllegalArgumentException?400:500;}
    private static String safeMessage(Exception error){return status(error)==500?"实时同步失败，请重试。":error.getMessage();}
    private static Map<String,Object> map(Object...pairs){Map<String,Object> result=new LinkedHashMap<>();for(int n=0;n<pairs.length;n+=2)result.put((String)pairs[n],pairs[n+1]);return result;}
    private static void exec(Connection c,String sql,Object...args)throws Exception{try(PreparedStatement statement=c.prepareStatement(sql)){bind(statement,args);statement.executeUpdate();}}
    private static Map<String,Object> one(Connection c,String sql,Object...args)throws Exception{List<Map<String,Object>> rows=all(c,sql,args);return rows.isEmpty()?null:rows.get(0);}
    private static List<Map<String,Object>> all(Connection c,String sql,Object...args)throws Exception{try(PreparedStatement statement=c.prepareStatement(sql)){bind(statement,args);try(ResultSet result=statement.executeQuery()){List<Map<String,Object>> rows=new ArrayList<>();int columns=result.getMetaData().getColumnCount();while(result.next()){Map<String,Object> row=new LinkedHashMap<>();for(int n=1;n<=columns;n++)row.put(result.getMetaData().getColumnLabel(n),result.getObject(n));rows.add(row);}return rows;}}}
    private static void bind(PreparedStatement statement,Object[] args)throws Exception{for(int n=0;n<args.length;n++){Object value=args[n];if(value instanceof byte[]bytes)statement.setBytes(n+1,bytes);else statement.setObject(n+1,value);}}
}
