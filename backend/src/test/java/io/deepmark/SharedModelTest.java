package io.deepmark;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class SharedModelTest {
    private static final SharedModel.Author A = new SharedModel.Author("engineer-a", "工程师 A");
    private static final SharedModel.Author B = new SharedModel.Author("engineer-b", "工程师 B");
    private static final SharedModel.Author ADMIN = new SharedModel.Author("reviewer", "审核员");

    private static List<int[]> edit(int index, int before, int after) {
        return List.of(new int[]{index, before, after});
    }

    private static SharedModel.Annotation opinion(SharedModel.Region region, String author) {
        return region.annotations.stream().filter(row -> row.author.equals(author)).findFirst().orElseThrow();
    }

    private static int opinionValue(SharedModel.Annotation row, int index) {
        return row.values.stream().filter(pair -> pair[0] == index).findFirst().orElseThrow()[1];
    }

    @Test
    void differentAuthorsKeepParallelOpinionsAndUpdateOnlyTheirOwnOpinion() {
        SharedModel.Model model = new SharedModel.Model(new int[]{3, 1, 1});
        SharedModel.apply(model, A, edit(0, 0, 1));
        SharedModel.apply(model, B, edit(1, 0, 1));

        SharedModel.ApplyResult conflict = SharedModel.apply(model, B, edit(0, 1, 2));
        assertEquals(1, conflict.conflictCount);
        assertTrue(conflict.applied.isEmpty());
        assertArrayEquals(new int[]{1, 1, 0}, model.mask);
        assertEquals(1, model.regions.size());
        SharedModel.Region region = model.regions.get(0);
        String regionId = region.id;
        assertEquals(List.of(0), region.indices);
        assertEquals(1, opinionValue(opinion(region, A.id), 0));
        assertEquals(2, opinionValue(opinion(region, B.id), 0));

        SharedModel.apply(model, B, edit(0, 2, 3));
        assertEquals(regionId, model.regions.get(0).id);
        assertEquals(2, model.regions.get(0).annotations.size());
        assertEquals(1, opinionValue(opinion(model.regions.get(0), A.id), 0));
        assertEquals(3, opinionValue(opinion(model.regions.get(0), B.id), 0));
        assertEquals(1, model.mask[0]);
    }

    @Test
    void eraseCannotRemoveAnotherAuthorsPrimaryAndWithdrawsOnlyOwnParallelOpinion() {
        SharedModel.Model model = new SharedModel.Model(new int[]{2, 1, 1});
        SharedModel.apply(model, A, edit(0, 0, 1));

        SharedModel.ApplyResult denied = SharedModel.apply(model, B, edit(0, 1, 0));
        assertEquals(1, denied.protectedCount);
        assertTrue(denied.applied.isEmpty());
        assertEquals(1, model.mask[0]);
        assertEquals(A.id, SharedModel.owner(model, 0).id);

        SharedModel.apply(model, B, edit(0, 1, 2));
        assertEquals(1, model.regions.size());
        SharedModel.ApplyResult withdrawal = SharedModel.apply(model, B, edit(0, 2, 0));
        assertEquals(0, withdrawal.protectedCount);
        assertEquals(1, model.mask[0]);
        assertEquals(A.id, SharedModel.owner(model, 0).id);
        assertTrue(model.regions.isEmpty(), "A single remaining positive opinion becomes the primary result");
    }

    @Test
    void withdrawingPrimaryOpinionTransfersValueAndOwnershipToRemainingAuthor() {
        SharedModel.Model model = new SharedModel.Model(new int[]{2, 1, 1});
        SharedModel.apply(model, A, edit(0, 0, 1));
        SharedModel.apply(model, B, edit(0, 1, 2));

        SharedModel.ApplyResult withdrawal = SharedModel.apply(model, A, edit(0, 1, 0));
        assertEquals(2, model.mask[0]);
        assertEquals(B.id, SharedModel.owner(model, 0).id);
        assertTrue(model.regions.isEmpty());
        assertEquals(1, withdrawal.applied.size());
        assertArrayEquals(new int[]{0, 1, 2}, withdrawal.applied.get(0));

        SharedModel.ApplyResult protectedAgain = SharedModel.apply(model, A, edit(0, 2, 0));
        assertEquals(1, protectedAgain.protectedCount);
        assertEquals(2, model.mask[0]);
    }

    @Test
    void withdrawingAnAgreedPrimaryPreservesConsensusAndTransfersOwnership() {
        SharedModel.Model model = new SharedModel.Model(new int[]{1, 1, 1});
        SharedModel.apply(model, A, edit(0, 0, 1));
        SharedModel.ApplyResult result = SharedModel.apply(model, A, edit(0, 1, 0), false, Map.of(0, B));
        assertEquals(1, model.mask[0]);
        assertEquals(B.id, SharedModel.owner(model, 0).id);
        assertTrue(result.applied.isEmpty(), "Ownership can transfer without changing the label");
        assertEquals(1, result.ownerUpdates.size());
        assertEquals(0, result.ownerUpdates.get(0)[0]);
    }

    @Test
    void partialReviewDoesNotShiftRemainingSparseOpinionValues() {
        SharedModel.Model model = new SharedModel.Model(new int[]{3, 1, 1});
        SharedModel.apply(model, A, List.of(new int[]{0, 0, 1}, new int[]{1, 0, 1}, new int[]{2, 0, 1}));
        SharedModel.apply(model, B, List.of(new int[]{0, 1, 2}, new int[]{1, 1, 2}, new int[]{2, 1, 2}));

        SharedModel.apply(model, ADMIN, edit(0, 1, 0), true, Map.of());
        assertEquals(List.of(1, 2), model.regions.get(0).indices);

        assertDoesNotThrow(() -> SharedModel.apply(model, B, edit(1, 2, 1)));
        SharedModel.Annotation row = opinion(model.regions.get(0), B.id);
        assertEquals(1, opinionValue(row, 1), "Updating index 1 must not target its former array offset");
        assertEquals(2, opinionValue(row, 2), "An untouched voxel must retain its opinion");

        SharedModel.apply(model, B, edit(2, 2, 3));
        assertEquals(1, opinionValue(row, 1));
        assertEquals(3, opinionValue(row, 2));
        assertArrayEquals(new int[]{0, 1, 1}, model.mask);
    }

    @Test
    void sixNeighbourComponentsJoinAcrossSlicesWithoutWrappingRowsOrPlanes() {
        int[] dims = {2, 2, 2};
        assertEquals(List.of(List.of(1, 5), List.of(2)), SharedModel.components(List.of(1, 5, 2), dims));
        assertEquals(List.of(List.of(1), List.of(2)), SharedModel.components(List.of(1, 2), dims));
        assertEquals(List.of(List.of(3), List.of(4)), SharedModel.components(List.of(3, 4), dims));

        SharedModel.Model model = new SharedModel.Model(dims);
        SharedModel.apply(model, A, List.of(new int[]{0, 0, 1}, new int[]{4, 0, 1}));
        SharedModel.apply(model, B, List.of(new int[]{0, 1, 2}, new int[]{4, 1, 2}));
        assertEquals(1, model.regions.size());
        assertEquals(List.of(0, 4), model.regions.get(0).indices);
        assertArrayEquals(new int[]{0, 0, 0}, model.regions.get(0).bounds.get("min"));
        assertArrayEquals(new int[]{0, 0, 1}, model.regions.get(0).bounds.get("max"));
    }

    @Test
    void copyIsolatesArraysOpinionValuesAndGeometry() {
        SharedModel.Model original = new SharedModel.Model(new int[]{2, 1, 1});
        SharedModel.apply(original, A, edit(0, 0, 1));
        SharedModel.apply(original, B, edit(0, 1, 2));
        SharedModel.Model copy = SharedModel.copy(original);
        copy.mask[0] = 9;
        copy.owners[0] = 0;
        copy.dims[0] = 8;
        copy.authors.get(0).name = "Changed";
        copy.regions.get(0).bounds.get("min")[0] = 8;
        opinion(copy.regions.get(0), B.id).values.get(0)[1] = 7;

        assertEquals(1, original.mask[0]);
        assertEquals(A.id, SharedModel.owner(original, 0).id);
        assertEquals(2, original.dims[0]);
        assertEquals(A.name, original.authors.get(0).name);
        assertEquals(0, original.regions.get(0).bounds.get("min")[0]);
        assertEquals(2, opinionValue(opinion(original.regions.get(0), B.id), 0));
    }
}
