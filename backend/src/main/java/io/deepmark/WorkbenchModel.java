package io.deepmark;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.*;

/** Collaborative storage/projection for native independent binary Masks.
 * This class performs no segmentation, meshing, measurement or resampling. */
public final class WorkbenchModel {
    public static final int MAGIC=0x31574244, HEADER=12, RECORD=12;
    public static final List<String> COLLECTIONS=List.of("masks","parts","measurements","centerlines","polylines","resliceObjects");
    public record Run(int start,int length,int before,int after) {}
    public record Patch(String mask,List<Run> runs) {}
    public record Result(WorkbenchModel model,int protectedCount,Set<String> changedMasks,Map<String,String> renamed) {}
    public static final class Layer {
        public final Map<String,BitSet> authors;
        public final BitSet union;
        Layer(){authors=new LinkedHashMap<>();union=new BitSet();}
        Layer(Layer old,String author){authors=new LinkedHashMap<>(old.authors);union=(BitSet)old.union.clone();BitSet own=authors.get(author);if(own!=null)authors.put(author,(BitSet)own.clone());}
        boolean others(String author){return authors.entrySet().stream().anyMatch(e->!e.getKey().equals(author)&&!e.getValue().isEmpty());}
    }
    public final int count;
    public final ObjectNode manifest;
    public final Map<String,Layer> layers;
    public final Map<String,String> owners;
    public final Map<String,Long> created;
    WorkbenchModel(int count,ObjectNode manifest,Map<String,Layer> layers,Map<String,String> owners,Map<String,Long> created){
        this.count=count;this.manifest=manifest;this.layers=layers;this.owners=owners;this.created=created;
    }
    public static WorkbenchModel empty(int count,String name){
        if(count<1)throw new IllegalArgumentException("影像体素数无效。");
        ObjectNode root=Platform.JSON.createObjectNode();root.put("name",name);
        for(String key:COLLECTIONS)root.putArray(key);
        ObjectNode mask=root.withArray("masks").addObject();mask.put("id","mask-1");mask.put("name","Mask 1");mask.put("color","#48d7ae");mask.put("revision",0);mask.putNull("threshold");
        Map<String,Layer> layers=new LinkedHashMap<>();layers.put("mask-1",new Layer());
        return new WorkbenchModel(count,root,layers,new LinkedHashMap<>(),new LinkedHashMap<>());
    }
    public static List<Run> decode(byte[] bytes,int count){
        if(bytes.length<HEADER)throw new IllegalArgumentException("标注操作头无效。");
        ByteBuffer input=ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
        long records=Integer.toUnsignedLong(input.getInt(8));
        if(input.getInt(0)!=MAGIC||input.getInt(4)!=RECORD||HEADER+records*RECORD!=bytes.length)
            throw new IllegalArgumentException("标注操作格式或长度无效。");
        List<Run> result=new ArrayList<>();long previous=0;
        for(int i=0;i<records;i++){
            int offset=HEADER+i*RECORD;long start=Integer.toUnsignedLong(input.getInt(offset)),length=Integer.toUnsignedLong(input.getInt(offset+4));int flags=input.getInt(offset+8);
            if(length==0||start<previous||start+length>count||(flags!=1&&flags!=2))throw new IllegalArgumentException("标注操作重叠、越界或值无效。");
            result.add(new Run((int)start,(int)length,flags&1,(flags>>>1)&1));previous=start+length;
        }
        return result;
    }
    public static byte[] encode(List<Run> runs){
        ByteBuffer output=ByteBuffer.allocate(Math.addExact(HEADER,Math.multiplyExact(runs.size(),RECORD))).order(ByteOrder.LITTLE_ENDIAN);
        output.putInt(MAGIC).putInt(RECORD).putInt(runs.size());
        for(Run run:runs)output.putInt(run.start).putInt(run.length).putInt(run.before|(run.after<<1));
        return output.array();
    }
    public List<Run> snapshot(String mask){
        Layer layer=layers.get(mask);if(layer==null)throw new IllegalArgumentException("Mask 不存在。");
        List<Run> runs=new ArrayList<>();
        for(int start=layer.union.nextSetBit(0);start>=0;){int end=layer.union.nextClearBit(start);runs.add(new Run(start,end-start,0,1));start=end>=count?-1:layer.union.nextSetBit(end);}
        return runs;
    }
    public Iterable<Run> snapshotRuns(String mask){
        Layer layer=layers.get(mask);if(layer==null)throw new IllegalArgumentException("Mask 不存在。");
        return runsOf(layer.union);
    }
    public Iterable<Run> claimRuns(String mask,String author){
        Layer layer=layers.get(mask);if(layer==null)throw new IllegalArgumentException("Mask 不存在。");
        return runsOf(layer.authors.getOrDefault(author,new BitSet()));
    }
    private Iterable<Run> runsOf(BitSet bits){
        return ()->new Iterator<>(){int position=bits.nextSetBit(0);
            public boolean hasNext(){return position>=0;}
            public Run next(){if(!hasNext())throw new NoSuchElementException();int start=position,end=bits.nextClearBit(start);position=end>=count?-1:bits.nextSetBit(end);return new Run(start,end-start,0,1);}
        };
    }
    public static Iterable<Run> deltaRuns(BitSet before,BitSet after){
        BitSet changed=(BitSet)before.clone();changed.xor(after);
        return ()->new Iterator<>(){int position=changed.nextSetBit(0),end=position<0?0:changed.nextClearBit(position);
            public boolean hasNext(){return position>=0;}
            public Run next(){if(!hasNext())throw new NoSuchElementException();int start=position;boolean value=after.get(start);
                int next=Math.min(end,value?after.nextClearBit(start):after.nextSetBit(start));if(next<0)next=end;
                Run run=new Run(start,next-start,value?0:1,value?1:0);position=next;
                if(position==end){position=changed.nextSetBit(end);if(position>=0)end=changed.nextClearBit(position);}return run;
            }
        };
    }
    public static List<Run> delta(BitSet before,BitSet after){
        BitSet changed=(BitSet)before.clone();changed.xor(after);List<Run> runs=new ArrayList<>();
        for(int start=changed.nextSetBit(0);start>=0;){
            int end=changed.nextClearBit(start),position=start;
            while(position<end){boolean value=after.get(position);int next=Math.min(end,value?after.nextClearBit(position):after.nextSetBit(position));
                if(next<0)next=end;runs.add(new Run(position,next-position,value?0:1,value?1:0));position=next;}
            start=changed.nextSetBit(end);
        }
        return runs;
    }
    public Result apply(Auth.User actor,long base,long revision,String op,JsonNode changes,List<Patch> patches){
        ObjectNode document=manifest.deepCopy();Map<String,Layer> nextLayers=new LinkedHashMap<>(layers);
        Map<String,String> nextOwners=new LinkedHashMap<>(owners);Map<String,Long> nextCreated=new LinkedHashMap<>(created);
        Map<String,String> renamed=new LinkedHashMap<>();Set<String> changedMasks=new LinkedHashSet<>();Map<String,Long> requestedVersions=new HashMap<>();int protectedCount=0;
        if(changes!=null&&!changes.isNull()&&!changes.isMissingNode()){
            if(!changes.isObject())throw new IllegalArgumentException("工程元数据操作无效。");
            if(changes.has("name")){String name=changes.path("name").asText();if(name.isBlank()||name.length()>512)throw new IllegalArgumentException("工程名称无效。");document.put("name",name);}
            if(changes.has("resliceTransform")){if(changes.get("resliceTransform").isNull())document.remove("resliceTransform");else document.set("resliceTransform",changes.get("resliceTransform").deepCopy());}
            if(changes.has("sourceUnit")){
                int unit=changes.path("sourceUnit").asInt(),old=document.path("sourceUnit").asInt();
                if(unit<1||unit>3)throw new IllegalArgumentException("影像空间单位无效。");
                if(old>0&&old!=unit)throw new IllegalArgumentException("团队已确认影像空间单位，不能在同一工程中重新解释。");
                document.put("sourceUnit",unit);
            }
            JsonNode upserts=changes.path("upserts"),removals=changes.path("removals");
            for(String collection:COLLECTIONS){
                ArrayNode objects=document.withArray(collection);
                JsonNode added=upserts.path(collection);if(!added.isMissingNode()&&!added.isArray())throw new IllegalArgumentException("对象更新列表无效。");
                for(JsonNode raw:added){
                    if(!raw.isObject())throw new IllegalArgumentException("对象元数据无效。");
                    ObjectNode value=raw.deepCopy();String id=value.path("id").asText();validId(id);
                    if(collection.equals("masks")){
                        if(value.has("data")||!value.path("name").isTextual()||!value.path("color").asText().matches("#[0-9a-fA-F]{6}"))throw new IllegalArgumentException("Mask 元数据无效。");
                        JsonNode threshold=value.get("threshold");if(threshold!=null&&!threshold.isNull()&&(!threshold.isArray()||threshold.size()!=2||!threshold.get(0).isNumber()||!threshold.get(1).isNumber()||threshold.get(0).asDouble()>threshold.get(1).asDouble()))throw new IllegalArgumentException("Mask 阈值无效。");
                    }
                    int index=find(objects,id);String key=collection+"/"+id,owner=nextOwners.get(key);
                    boolean collision=index>=0&&nextCreated.getOrDefault(key,0L)>base&&!Objects.equals(owner,actor.id());
                    boolean parallel=index>=0&&!collection.equals("masks")&&owner!=null&&!owner.equals(actor.id());
                    if(collision||parallel){String alternate=forkId(id,actor.id(),op);renamed.put(collection+"/"+id,alternate);id=alternate;value.put("id",id);key=collection+"/"+id;index=find(objects,id);}
                    if(collection.equals("masks")){
                        JsonNode prior=index<0?null:objects.get(index);long version=prior==null?nextCreated.getOrDefault("version:masks/"+id,0L):prior.path("revision").asLong(),requested=value.path("revision").asLong(0);
                        if(requested<0||requested>9007199254740991L)throw new IllegalArgumentException("Mask 版本无效。");
                        requestedVersions.put(id,requested);value.put("revision",prior==null?Math.max(version,requested):version);if(!nextLayers.containsKey(id))nextLayers.put(id,new Layer());
                    }
                    if(index<0){objects.add(value);nextOwners.put(key,actor.id());nextCreated.put(key,revision);}else objects.set(index,value);
                }
                JsonNode deleted=removals.path(collection);if(!deleted.isMissingNode()&&!deleted.isArray())throw new IllegalArgumentException("对象删除列表无效。");
                for(JsonNode value:deleted){
                    String id=value.asText();validId(id);int index=find(objects,id);if(index<0)continue;
                    String key=collection+"/"+id;Layer layer=nextLayers.get(id);
                    boolean protect=collection.equals("masks")?layer!=null&&layer.others(actor.id()):nextOwners.containsKey(key)&&!actor.id().equals(nextOwners.get(key));
                    if(protect){protectedCount++;continue;}
                    if(collection.equals("masks"))nextCreated.put("version:masks/"+id,objects.get(index).path("revision").asLong());
                    objects.remove(index);nextOwners.remove(key);nextCreated.remove(key);if(collection.equals("masks")){nextLayers.remove(id);changedMasks.add(id);}
                }
            }
        }
        Set<String> cloned=new HashSet<>();Map<String,Integer> ends=new HashMap<>();
        for(Patch patch:patches){
            String mask=renamed.getOrDefault("masks/"+patch.mask,patch.mask);Layer layer=nextLayers.get(mask);
            if(layer==null)throw new IllegalArgumentException("操作包含未知 Mask。");
            if(cloned.add(mask)){layer=new Layer(layer,actor.id());nextLayers.put(mask,layer);}
            BitSet own=layer.authors.computeIfAbsent(actor.id(),key->new BitSet());
            int previous=ends.getOrDefault(mask,0);
            for(Run run:patch.runs){
                if(run.start<previous||run.length<1||(long)run.start+run.length>count||run.before==run.after||(run.before!=0&&run.before!=1)||(run.after!=0&&run.after!=1))throw new IllegalArgumentException("标注范围无效。");
                int end=run.start+run.length;previous=end;
                if(run.after==1){own.set(run.start,end);layer.union.set(run.start,end);}
                else{
                    own.clear(run.start,end);layer.union.clear(run.start,end);
                    for(var other:layer.authors.entrySet())if(!other.getKey().equals(actor.id())){
                        BitSet retained=other.getValue().get(run.start,end);for(int p=retained.nextSetBit(0);p>=0;){int e=retained.nextClearBit(p);layer.union.set(run.start+p,run.start+e);p=retained.nextSetBit(e);}
                    }
                    protectedCount+=layer.union.get(run.start,end).cardinality();
                }
            }
            ends.put(mask,previous);
        }
        for(String mask:cloned){
            BitSet previous=layers.containsKey(mask)?layers.get(mask).union:new BitSet();
            if(!previous.equals(nextLayers.get(mask).union)){
                changedMasks.add(mask);int index=find(document.withArray("masks"),mask);
                ObjectNode def=(ObjectNode)document.withArray("masks").get(index);if(layers.containsKey(mask))def.put("revision",def.path("revision").asLong()+1);
            }
        }
        for(var requested:requestedVersions.entrySet()){
            int index=find(document.withArray("masks"),requested.getKey());if(index<0||!layers.containsKey(requested.getKey()))continue;
            ObjectNode def=(ObjectNode)document.withArray("masks").get(index);def.put("revision",Math.max(def.path("revision").asLong(),requested.getValue()));
        }
        for(JsonNode mask:document.withArray("masks"))nextCreated.put("version:masks/"+mask.path("id").asText(),mask.path("revision").asLong());
        for(String collection:List.of("parts","centerlines","polylines"))for(JsonNode item:document.withArray(collection)){
            if(!item.has("sourceRevision"))continue;JsonNode version=item.get("sourceRevision");
            if(!version.isIntegralNumber()||version.asLong()<0)throw new IllegalArgumentException("来源版本无效。");
            int index=find(document.withArray("masks"),item.path("sourceMaskId").asText());
            if(index>=0&&version.asLong()>document.withArray("masks").get(index).path("revision").asLong())throw new IllegalArgumentException("对象引用未来的 Mask 版本。");
        }
        return new Result(new WorkbenchModel(count,document,nextLayers,nextOwners,nextCreated),protectedCount,changedMasks,renamed);
    }
    public ObjectNode archive(){
        ObjectNode output=Platform.JSON.createObjectNode();output.put("count",count);output.set("manifest",manifest.deepCopy());
        output.set("owners",Platform.JSON.valueToTree(owners));output.set("created",Platform.JSON.valueToTree(created));
        ArrayNode claims=output.putArray("claims");
        for(var layer:layers.entrySet())for(var author:layer.getValue().authors.entrySet()){
            ObjectNode row=claims.addObject();row.put("mask",layer.getKey());row.put("author",author.getKey());row.put("bits",Base64.getEncoder().encodeToString(author.getValue().toByteArray()));
        }
        return output;
    }
    public static WorkbenchModel restore(JsonNode archive){
        int count=archive.path("count").asInt();if(count<1||!archive.path("manifest").isObject())throw new IllegalArgumentException("共享工程快照无效。");
        Map<String,Layer> layers=new LinkedHashMap<>();for(JsonNode mask:archive.path("manifest").path("masks"))layers.put(mask.path("id").asText(),new Layer());
        for(JsonNode row:archive.path("claims")){
            Layer layer=layers.get(row.path("mask").asText());if(layer==null)throw new IllegalArgumentException("共享快照引用未知 Mask。");
            BitSet bits=BitSet.valueOf(Base64.getDecoder().decode(row.path("bits").asText()));if(bits.length()>count)throw new IllegalArgumentException("共享快照体素越界。");
            layer.authors.put(row.path("author").asText(),bits);layer.union.or(bits);
        }
        Map<String,String> owners=new LinkedHashMap<>();archive.path("owners").fields().forEachRemaining(e->owners.put(e.getKey(),e.getValue().asText()));
        Map<String,Long> created=new LinkedHashMap<>();archive.path("created").fields().forEachRemaining(e->created.put(e.getKey(),e.getValue().asLong()));
        return new WorkbenchModel(count,((ObjectNode)archive.get("manifest")).deepCopy(),layers,owners,created);
    }
    public static int find(ArrayNode objects,String id){for(int i=0;i<objects.size();i++)if(objects.get(i).path("id").asText().equals(id))return i;return -1;}
    private static String forkId(String id,String author,String op){
        try{byte[] hash=java.security.MessageDigest.getInstance("SHA-256").digest((author+":"+op).getBytes(java.nio.charset.StandardCharsets.UTF_8));return id.substring(0,Math.min(220,id.length()))+"-"+HexFormat.of().formatHex(hash).substring(0,20);}
        catch(java.security.NoSuchAlgorithmException error){throw new IllegalStateException(error);}
    }
    public static void validId(String id){if(id==null||id.isBlank()||id.length()>256||id.chars().anyMatch(Character::isISOControl))throw new IllegalArgumentException("对象编号无效。");}
}
