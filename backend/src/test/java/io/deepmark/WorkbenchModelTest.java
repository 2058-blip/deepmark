package io.deepmark;
import org.junit.jupiter.api.Test;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
class WorkbenchModelTest {
    final Auth.User a=new Auth.User("A","a","作者A","worker"),b=new Auth.User("B","b","作者B","worker");
    WorkbenchModel.Patch patch(String mask,int start,int length,int before,int after){return new WorkbenchModel.Patch(mask,List.of(new WorkbenchModel.Run(start,length,before,after)));}
    @Test void nativeIndependentMasksOverlapAndForeignClaimsCannotBeErased(){
        var model=WorkbenchModel.empty(100,"CT");
        var meta=Platform.JSON.createObjectNode();var added=meta.putObject("upserts").putArray("masks").addObject();
        added.put("id","second");added.put("name","Second");added.put("color","#ffffff");added.putNull("threshold");
        model=model.apply(a,0,1,"operation-a",meta,List.of(patch("mask-1",10,20,0,1),patch("second",20,20,0,1))).model();
        assertTrue(model.layers.get("mask-1").union.get(25));assertTrue(model.layers.get("second").union.get(25));
        var denied=model.apply(b,1,2,"operation-b",null,List.of(patch("mask-1",10,20,1,0)));
        assertEquals(20,denied.protectedCount());assertEquals(20,denied.model().layers.get("mask-1").union.cardinality());
        var own=model.apply(a,1,2,"operation-c",null,List.of(patch("mask-1",10,20,1,0))).model();
        assertTrue(own.layers.get("mask-1").union.isEmpty());assertEquals(20,model.layers.get("mask-1").union.cardinality());
    }
    @Test void sharedAgreementRetainsAnotherAuthorsWorkAndSnapshotRestoresOwnership(){
        var model=WorkbenchModel.empty(30,"CT").apply(a,0,1,"a",null,List.of(patch("mask-1",5,5,0,1))).model();
        model=model.apply(b,1,2,"b",null,List.of(patch("mask-1",5,5,0,1))).model();
        model=model.apply(a,2,3,"c",null,List.of(patch("mask-1",5,5,1,0))).model();
        var restored=WorkbenchModel.restore(model.archive());assertEquals(5,restored.layers.get("mask-1").union.cardinality());
        assertTrue(restored.layers.get("mask-1").authors.get("A").isEmpty());assertEquals(5,restored.layers.get("mask-1").authors.get("B").cardinality());
    }
    @Test void protocolMatchesBrowserLittleEndianRunsAndRejectsMalformedRanges(){
        var runs=List.of(new WorkbenchModel.Run(2,3,0,1),new WorkbenchModel.Run(10,4,1,0));
        byte[] encoded=WorkbenchModel.encode(runs);assertEquals(runs,WorkbenchModel.decode(encoded,20));
        assertThrows(IllegalArgumentException.class,()->WorkbenchModel.decode(Arrays.copyOf(encoded,encoded.length-1),20));
        assertThrows(IllegalArgumentException.class,()->WorkbenchModel.decode(encoded,12));
    }
    @Test void parallelObjectEditsPreserveForeignModelsAndObjectDeletionIsProtected(){
        var first=Platform.JSON.createObjectNode();first.putObject("upserts").putArray("measurements").addObject().put("id","distance").put("name","Distance");
        var model=WorkbenchModel.empty(20,"CT").apply(a,0,1,"first-object",first,List.of()).model();
        var second=first.deepCopy();((com.fasterxml.jackson.databind.node.ObjectNode)second.path("upserts").path("measurements").get(0)).put("name","Other distance");
        var result=model.apply(b,1,2,"second-object",second,List.of());assertEquals(2,result.model().manifest.withArray("measurements").size());assertFalse(result.renamed().isEmpty());
        var delete=Platform.JSON.createObjectNode();delete.putObject("removals").putArray("measurements").add("distance");
        assertEquals(1,result.model().apply(b,2,3,"delete-object",delete,List.of()).protectedCount());
    }
    @Test void deletingAndUndoRestoringMaskKeepsNativeVersionAndRejectsFutureModelSources(){
        var model=WorkbenchModel.empty(30,"CT").apply(a,0,1,"paint",null,List.of(patch("mask-1",5,5,0,1))).model();
        long version=model.manifest.withArray("masks").get(0).path("revision").asLong();
        var definition=model.manifest.withArray("masks").get(0).deepCopy();
        var remove=Platform.JSON.createObjectNode();remove.putObject("removals").putArray("masks").add("mask-1");
        model=model.apply(a,1,2,"remove",remove,List.of()).model();assertTrue(model.layers.isEmpty());
        var restore=Platform.JSON.createObjectNode();restore.putObject("upserts").putArray("masks").add(definition);
        model=model.apply(a,2,3,"undo",restore,List.of(patch("mask-1",5,5,0,1))).model();
        assertEquals(version,model.manifest.withArray("masks").get(0).path("revision").asLong());assertEquals(5,model.layers.get("mask-1").union.cardinality());
        var future=Platform.JSON.createObjectNode();future.putObject("upserts").putArray("parts").addObject().put("id","part").put("sourceMaskId","mask-1").put("sourceRevision",version+1);
        var target=model;assertThrows(IllegalArgumentException.class,()->target.apply(a,3,4,"future",future,List.of()));
    }
    @Test void spatialUnitIsSharedAndCannotBeReinterpretedAfterConfirmation(){
        var model=WorkbenchModel.empty(10,"CT");var unit=Platform.JSON.createObjectNode().put("sourceUnit",1);
        model=model.apply(a,0,1,"unit",unit,List.of()).model();assertEquals(1,model.manifest.path("sourceUnit").asInt());
        var target=model;assertThrows(IllegalArgumentException.class,()->target.apply(b,1,2,"other-unit",Platform.JSON.createObjectNode().put("sourceUnit",2),List.of()));
    }
}
