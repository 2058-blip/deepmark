package io.deepmark;

import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

/** The shared voxel/parallel-opinion model, independent of HTTP and persistence. */
public final class SharedModel {
    private SharedModel() {}

    public static final class Failure extends RuntimeException {
        public final int status;
        public Failure(int status, String message) { super(message); this.status = status; }
    }

    public static final class Author {
        public String id;
        public String name;
        public Author() {}
        public Author(String id, String name) { this.id = id; this.name = name; }
    }

    public static final class Annotation {
        public String id;
        public String author;
        public String name;
        public String sourceKey;
        public List<int[]> values = new ArrayList<>();
        public String created;
        public Annotation() {}
    }

    public static final class Region {
        public String id;
        public List<Integer> indices = new ArrayList<>();
        public List<Annotation> annotations = new ArrayList<>();
        public Map<String, int[]> bounds = new LinkedHashMap<>();
        public String created;
        public String updated;
        public Region() {}
    }

    public static final class Model {
        public int[] mask;
        public int[] owners;
        public int[] dims;
        public List<Author> authors = new ArrayList<>();
        public List<Region> regions = new ArrayList<>();
        public Model() {}
        public Model(int[] dims) {
            this.dims = dims.clone();
            int count = voxelCount(dims);
            this.mask = new int[count];
            this.owners = new int[count];
        }
        public Model(int[] mask, int[] owners, int[] dims,
                     List<Author> authors, List<Region> regions) {
            this.mask = mask;
            this.owners = owners;
            this.dims = dims;
            this.authors = authors;
            this.regions = regions;
        }
    }

    public static final class ApplyResult {
        public Model model;
        public List<int[]> applied = new ArrayList<>();
        public List<int[]> ownerUpdates = new ArrayList<>();
        public int conflictCount;
        public int protectedCount;
        private ApplyResult(Model model) { this.model = model; }
    }

    private record Conflict(int current, int after, Author previousOwner) {}
    private record Remaining(Annotation annotation, int value) {}

    public static int voxelCount(int[] dims) {
        if (dims == null || dims.length != 3 || Arrays.stream(dims).anyMatch(n -> n < 1))
            throw new Failure(400, "影像尺寸无效。");
        long count = (long) dims[0] * dims[1] * dims[2];
        if (count > Integer.MAX_VALUE) throw new Failure(400, "影像尺寸超出支持范围。");
        return (int) count;
    }

    /** Connected components use six-neighbour voxel connectivity, without row wrapping. */
    public static List<List<Integer>> components(Collection<Integer> indices, int[] dims) {
        int count = voxelCount(dims), nx = dims[0], ny = dims[1], plane = nx * ny;
        Set<Integer> remaining = new LinkedHashSet<>(indices);
        for (int i : remaining) if (i < 0 || i >= count) throw new Failure(400, "体素索引越界。");
        List<List<Integer>> result = new ArrayList<>();
        while (!remaining.isEmpty()) {
            int first = remaining.iterator().next();
            remaining.remove(first);
            List<Integer> group = new ArrayList<>();
            ArrayDeque<Integer> queue = new ArrayDeque<>();
            queue.add(first);
            while (!queue.isEmpty()) {
                int i = queue.removeFirst(), x = i % nx, y = i / nx % ny;
                group.add(i);
                int[] neighbours = {x > 0 ? i - 1 : -1, x < nx - 1 ? i + 1 : -1,
                        y > 0 ? i - nx : -1, y < ny - 1 ? i + nx : -1,
                        i >= plane ? i - plane : -1, i < count - plane ? i + plane : -1};
                for (int j : neighbours) if (remaining.remove(j)) queue.addLast(j);
            }
            Collections.sort(group);
            result.add(group);
        }
        return result;
    }

    public static Map<String, int[]> bounds(Collection<Integer> indices, int[] dims) {
        int[] min = {Integer.MAX_VALUE, Integer.MAX_VALUE, Integer.MAX_VALUE};
        int[] max = {0, 0, 0};
        for (int i : indices) {
            int[] point = {i % dims[0], i / dims[0] % dims[1], i / (dims[0] * dims[1])};
            for (int axis = 0; axis < 3; axis++) {
                min[axis] = Math.min(min[axis], point[axis]);
                max[axis] = Math.max(max[axis], point[axis]);
            }
        }
        if (indices.isEmpty()) Arrays.fill(min, 0);
        Map<String, int[]> result = new LinkedHashMap<>();
        result.put("min", min);
        result.put("max", max);
        return result;
    }

    private static int authorCode(Model model, Author person) {
        for (int i = 0; i < model.authors.size(); i++)
            if (Objects.equals(model.authors.get(i).id, person.id)) return i + 1;
        model.authors.add(new Author(person.id, person.name));
        return model.authors.size();
    }

    public static Author owner(Model model, int index) {
        int code = model.owners[index];
        return code > 0 && code <= model.authors.size()
                ? model.authors.get(code - 1) : new Author("existing", "已有标注");
    }

    private static Annotation option(Region region, Author person, String sourceKey, String now) {
        for (Annotation row : region.annotations) {
            String key = row.sourceKey == null || row.sourceKey.isEmpty() ? row.author : row.sourceKey;
            if (Objects.equals(key, sourceKey)) return row;
        }
        Annotation row = new Annotation();
        row.id = UUID.randomUUID().toString();
        row.author = person.id;
        row.name = person.name;
        row.sourceKey = sourceKey;
        row.created = now;
        region.annotations.add(row);
        return row;
    }

    /** Lookups last only for one application; filtering a row cannot leave a stale index cache. */
    private static final class Values {
        final Map<Annotation, Map<Integer, int[]>> lookups = new IdentityHashMap<>();
        Map<Integer, int[]> lookup(Annotation row) {
            return lookups.computeIfAbsent(row, annotation -> {
                Map<Integer, int[]> values = new LinkedHashMap<>();
                for (int[] pair : annotation.values) values.put(pair[0], pair);
                return values;
            });
        }
        void set(Annotation row, int index, int value) {
            Map<Integer, int[]> values = lookup(row);
            int[] pair = values.get(index);
            if (pair == null) { pair = new int[]{index, value}; row.values.add(pair); values.put(index, pair); }
            else pair[1] = value;
        }
        Integer get(Annotation row, int index) {
            int[] pair = lookup(row).get(index);
            return pair == null ? null : pair[1];
        }
        void remove(Annotation row, int index) {
            row.values.removeIf(pair -> pair[0] == index);
            Map<Integer, int[]> cached = lookups.get(row);
            if (cached != null) cached.remove(index);
        }
        void removeAll(Annotation row, Set<Integer> indices) {
            row.values.removeIf(pair -> indices.contains(pair[0]));
            lookups.remove(row);
        }
    }

    public static ApplyResult apply(Model model, Author person, List<int[]> entries) {
        return apply(model, person, entries, false, Map.of());
    }

    public static ApplyResult apply(Model model, Author person, List<int[]> entries,
                                    boolean review, Map<Integer, Author> agreements) {
        int count = voxelCount(model.dims);
        if (model.mask == null || model.owners == null || model.mask.length != count || model.owners.length != count)
            throw new Failure(400, "共享标注尺寸无效。");
        if (person == null || person.id == null || person.id.isBlank()) throw new Failure(401, "请先登录。");
        for (int[] row : entries) {
            if (row == null || row.length != 3 || row[0] < 0 || row[0] >= count
                    || row[1] < 0 || row[1] > 65535 || row[2] < 0 || row[2] > 65535)
                throw new Failure(400, "编辑体素或标签值无效。");
        }
        if (agreements == null) agreements = Map.of();
        final Map<Integer, Author> agreed = agreements;
        ApplyResult result = new ApplyResult(model);
        int code = authorCode(model, person);
        Map<Integer, Region> byVoxel = new LinkedHashMap<>();
        Map<Integer, Conflict> conflicts = new LinkedHashMap<>();
        Map<Region, Set<Integer>> removed = new LinkedHashMap<>();
        Set<Integer> withdrawn = new LinkedHashSet<>();
        String now = Instant.now().toString();
        Values values = new Values();
        for (Region region : model.regions) for (int index : region.indices) byVoxel.put(index, region);

        class Primary {
            void set(int index, int value) { set(index, value, person, false); }
            void set(int index, int value, Author author, boolean transfer) {
                int nextOwner = value == 0 ? 0 : Objects.equals(author.id, person.id) ? code : authorCode(model, author);
                if (model.mask[index] != value) {
                    result.applied.add(new int[]{index, model.mask[index], value});
                    model.mask[index] = value;
                    model.owners[index] = nextOwner;
                    result.ownerUpdates.add(new int[]{index, nextOwner});
                } else if ((review || transfer) && model.owners[index] != nextOwner) {
                    model.owners[index] = nextOwner;
                    result.ownerUpdates.add(new int[]{index, nextOwner});
                }
            }
        }
        Primary primary = new Primary();
        for (int[] entry : entries) {
            int index = entry[0], before = entry[1], after = entry[2], current = model.mask[index];
            Region region = byVoxel.get(index);
            if (review) {
                primary.set(index, after);
                if (region != null) removed.computeIfAbsent(region, ignored -> new LinkedHashSet<>()).add(index);
                continue;
            }
            if (after == 0) {
                if (region != null) {
                    List<Annotation> own = new ArrayList<>();
                    for (Annotation row : region.annotations)
                        if (Objects.equals(row.author, person.id) && values.get(row, index) != null) own.add(row);
                    if (own.isEmpty() && !Objects.equals(owner(model, index).id, person.id)) {
                        boolean annotated = current != 0;
                        for (Annotation row : region.annotations) {
                            Integer value = values.get(row, index);
                            if (value != null && value != 0) annotated = true;
                        }
                        if (annotated) result.protectedCount++;
                        continue;
                    }
                    for (Annotation row : own) values.remove(row, index);
                    withdrawn.add(index);
                    region.updated = now;
                } else if (model.owners[index] != 0 && Objects.equals(owner(model, index).id, person.id)) {
                    Author agreement = agreed.get(index);
                    if (agreement != null) primary.set(index, current, agreement, true);
                    else primary.set(index, 0);
                } else if (current != 0) result.protectedCount++;
                continue;
            }
            if (region != null) {
                values.set(option(region, person, person.id, now), index, after);
                if (Objects.equals(owner(model, index).id, person.id)) primary.set(index, after);
                region.updated = now;
                result.conflictCount++;
                continue;
            }
            Author previousOwner = agreed.getOrDefault(index, owner(model, index));
            boolean differentAuthor = agreed.containsKey(index)
                    || current != 0 && !Objects.equals(previousOwner.id, person.id);
            if (current != after && (current != before || differentAuthor)) {
                if (agreed.containsKey(index)) {
                    model.owners[index] = authorCode(model, previousOwner);
                    result.ownerUpdates.add(new int[]{index, model.owners[index]});
                }
                conflicts.put(index, new Conflict(current, after, previousOwner));
                result.conflictCount++;
            } else primary.set(index, after);
        }

        for (Region region : model.regions) for (int index : region.indices) if (withdrawn.contains(index)) {
            List<Remaining> remaining = new ArrayList<>();
            for (Annotation row : region.annotations) {
                Integer value = values.get(row, index);
                if (value != null) remaining.add(new Remaining(row, value));
            }
            if (remaining.isEmpty()) {
                primary.set(index, 0);
                removed.computeIfAbsent(region, ignored -> new LinkedHashSet<>()).add(index);
            } else {
                String existingOwner = owner(model, index).id;
                Remaining choice = remaining.stream().filter(item -> Objects.equals(item.annotation.author, existingOwner)).findFirst()
                        .orElseGet(() -> remaining.stream().filter(item -> item.value != 0).findFirst().orElse(remaining.get(0)));
                primary.set(index, choice.value, new Author(choice.annotation.author, choice.annotation.name), true);
                if (remaining.size() == 1 && choice.value != 0)
                    removed.computeIfAbsent(region, ignored -> new LinkedHashSet<>()).add(index);
            }
        }
        for (Map.Entry<Region, Set<Integer>> removal : removed.entrySet()) {
            Region region = removal.getKey();
            region.indices.removeIf(removal.getValue()::contains);
            for (Annotation row : region.annotations) values.removeAll(row, removal.getValue());
        }
        for (List<Integer> indices : components(conflicts.keySet(), model.dims)) {
            Region region = new Region();
            region.id = UUID.randomUUID().toString();
            region.indices = indices;
            region.bounds = bounds(indices, model.dims);
            region.created = now;
            region.updated = now;
            for (int index : indices) {
                Conflict conflict = conflicts.get(index);
                values.set(option(region, conflict.previousOwner, conflict.previousOwner.id, now), index, conflict.current);
                String sourceKey = Objects.equals(conflict.previousOwner.id, person.id) ? person.id + ":incoming" : person.id;
                values.set(option(region, person, sourceKey, now), index, conflict.after);
            }
            model.regions.add(region);
        }
        model.regions.removeIf(region -> region.indices.isEmpty());
        for (Region region : model.regions) {
            region.bounds = bounds(region.indices, model.dims);
            region.annotations.removeIf(row -> row.values.isEmpty());
        }
        return result;
    }

    public static ApplyResult resolve(Model model, Author person, String regionId,
                                      String annotationId, Integer label) {
        Region region = model.regions.stream().filter(row -> Objects.equals(row.id, regionId)).findFirst()
                .orElseThrow(() -> new Failure(404, "并列标注区域不存在或已处理。"));
        Annotation row = region.annotations.stream().filter(value -> Objects.equals(value.id, annotationId)).findFirst().orElse(null);
        if (label == null && row == null) throw new Failure(400, "请选择需要采用的标注。");
        if (label != null && (label < 0 || label > 65535)) throw new Failure(400, "标签值无效。");
        List<int[]> entries = new ArrayList<>();
        if (label == null) for (int[] value : row.values) entries.add(new int[]{value[0], model.mask[value[0]], value[1]});
        else for (int index : region.indices) entries.add(new int[]{index, model.mask[index], label});
        return apply(model, person, entries, true, Map.of());
    }

    public static Model copy(Model source) {
        List<Author> authors = new ArrayList<>();
        for (Author author : source.authors) authors.add(new Author(author.id, author.name));
        List<Region> regions = new ArrayList<>();
        for (Region original : source.regions) {
            Region region = new Region();
            region.id = original.id;
            region.indices = new ArrayList<>(original.indices);
            region.created = original.created;
            region.updated = original.updated;
            original.bounds.forEach((key, value) -> region.bounds.put(key, value.clone()));
            for (Annotation originalRow : original.annotations) {
                Annotation row = new Annotation();
                row.id = originalRow.id;
                row.author = originalRow.author;
                row.name = originalRow.name;
                row.sourceKey = originalRow.sourceKey;
                row.created = originalRow.created;
                for (int[] pair : originalRow.values) row.values.add(pair.clone());
                region.annotations.add(row);
            }
            regions.add(region);
        }
        return new Model(source.mask.clone(), source.owners.clone(), source.dims.clone(), authors, regions);
    }
}
