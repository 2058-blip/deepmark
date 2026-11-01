package io.deepmark;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;

/** NIfTI-1 geometry and label-map codec. Download fingerprints refer to original bytes. */
public final class Nifti {
    public static final int MAX_VOXELS = 128 * 1024 * 1024;
    private static final int MAX_RAW_BYTES = 1024 * 1024 * 1024;
    public record Volume(byte[] header, int[] dims, int count, boolean littleEndian) {}
    private Nifti() {}

    public static Volume parse(byte[] downloadedBytes) {
        byte[] bytes = downloadedBytes.length > 1 && (downloadedBytes[0] & 255) == 31 &&
                (downloadedBytes[1] & 255) == 139 ? gunzip(downloadedBytes, MAX_RAW_BYTES) : downloadedBytes;
        if (bytes.length < 352) throw new IllegalArgumentException("文件过短，不是完整的 NIfTI-1 影像。");
        ByteBuffer view = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
        boolean little = view.getInt(0) == 348;
        if (!little) view.order(ByteOrder.BIG_ENDIAN);
        if (view.getInt(0) != 348 || bytes[344] != 'n' || bytes[345] != '+' || bytes[346] != '1' || bytes[347] != 0)
            throw new IllegalArgumentException("目前只支持 NIfTI-1 单文件影像。");
        int rank = view.getShort(40);
        if (rank < 3 || rank > 7) throw new IllegalArgumentException("需要三维 NIfTI 影像。");
        for (int axis = 4; axis <= rank; axis++) if (view.getShort(40 + axis * 2) != 1)
            throw new IllegalArgumentException("请先将时间序列或多通道影像拆分为三维影像。");
        int[] dims = {view.getShort(42), view.getShort(44), view.getShort(46)};
        long count = 1;
        for (int dim : dims) { if (dim < 1) throw new IllegalArgumentException("影像尺寸无效。"); count *= dim; }
        if (count > MAX_VOXELS) throw new IllegalArgumentException("影像超过此版本的体素上限。");
        int kind = view.getShort(70);
        int bytesPerVoxel = switch (kind) {
            case 2, 256 -> 1; case 4, 512 -> 2; case 8, 16, 768 -> 4; case 64 -> 8;
            default -> throw new IllegalArgumentException("不支持此 NIfTI 灰度数据类型。");
        };
        float offset = view.getFloat(108);
        if (view.getShort(72) != bytesPerVoxel * 8 || !Float.isFinite(offset) || offset < 352 ||
                offset != Math.floor(offset) || (long) offset + count * bytesPerVoxel > bytes.length)
            throw new IllegalArgumentException("影像位深、数据偏移或数据长度无效。");
        double[] spacing = new double[3];
        for (int axis = 0; axis < 3; axis++) {
            spacing[axis] = Math.abs(view.getFloat(80 + axis * 4));
            if (!Double.isFinite(spacing[axis]) || spacing[axis] == 0) throw new IllegalArgumentException("体素间距无效。");
        }
        double slope = view.getFloat(112), intercept = view.getFloat(116);
        if (slope == 0) { slope = 1; intercept = 0; }
        if (!Double.isFinite(slope) || !Double.isFinite(intercept))
            throw new IllegalArgumentException("影像灰度缩放参数无效。");
        // Validate the same scaled Float32 domain used by the browser, without allocating another volume.
        for (int i = 0; i < count; i++) {
            int position = (int) offset + i * bytesPerVoxel;
            double raw = switch (kind) {
                case 2 -> Byte.toUnsignedInt(view.get(position));
                case 256 -> view.get(position);
                case 4 -> view.getShort(position);
                case 512 -> Short.toUnsignedInt(view.getShort(position));
                case 8 -> view.getInt(position);
                case 768 -> Integer.toUnsignedLong(view.getInt(position));
                case 16 -> view.getFloat(position);
                case 64 -> view.getDouble(position);
                default -> throw new IllegalArgumentException("不支持此 NIfTI 数据类型。");
            };
            double value = raw * slope + intercept;
            if (!Double.isFinite(value) || Math.abs(value) > 3.402823466e38)
                throw new IllegalArgumentException("影像包含无法显示的非有限灰度值。");
        }
        validateGeometry(view, spacing);
        return new Volume(Arrays.copyOf(bytes, 348), dims, (int) count, little);
    }

    private static void validateGeometry(ByteBuffer view, double[] spacing) {
        double[][] affine = {{spacing[0],0,0,0},{0,spacing[1],0,0},{0,0,spacing[2],0}};
        if (view.getShort(254) > 0) {
            for (int row = 0; row < 3; row++) for (int col = 0; col < 4; col++)
                affine[row][col] = view.getFloat(280 + row * 16 + col * 4);
        } else if (view.getShort(252) > 0) {
            double b = view.getFloat(256), c = view.getFloat(260), d = view.getFloat(264);
            double aa = 1 - b*b - c*c - d*d;
            if (aa < 1e-7) { double norm = Math.hypot(Math.hypot(b,c),d); b/=norm; c/=norm; d/=norm; aa=0; }
            double a = Math.sqrt(aa), qfac = view.getFloat(76) < 0 ? -1 : 1;
            double[][] rotation = {{a*a+b*b-c*c-d*d,2*(b*c-a*d),2*(b*d+a*c)},
                    {2*(b*c+a*d),a*a+c*c-b*b-d*d,2*(c*d-a*b)},
                    {2*(b*d-a*c),2*(c*d+a*b),a*a+d*d-c*c-b*b}};
            for (int row = 0; row < 3; row++) {
                for (int col = 0; col < 3; col++) affine[row][col] = rotation[row][col] * spacing[col] * (col==2?qfac:1);
                affine[row][3] = view.getFloat(268 + row * 4);
            }
        }
        for (double[] row : affine) for (double value : row)
            if (!Double.isFinite(value)) throw new IllegalArgumentException("影像方向矩阵无效。");
        double determinant = affine[0][0]*(affine[1][1]*affine[2][2]-affine[1][2]*affine[2][1])
                -affine[0][1]*(affine[1][0]*affine[2][2]-affine[1][2]*affine[2][0])
                +affine[0][2]*(affine[1][0]*affine[2][1]-affine[1][1]*affine[2][0]);
        if (!Double.isFinite(determinant) || Math.abs(determinant)<1e-12)
            throw new IllegalArgumentException("影像方向矩阵不可逆。");
    }

    public static byte[] export(Volume volume, int[] labels) {
        if (labels.length != volume.count()) throw new IllegalArgumentException("分割尺寸与影像不一致。");
        ByteBuffer out = ByteBuffer.allocate(Math.addExact(352, Math.multiplyExact(labels.length, 2)))
                .order(volume.littleEndian() ? ByteOrder.LITTLE_ENDIAN : ByteOrder.BIG_ENDIAN);
        out.put(volume.header());
        out.putShort(70, (short) 512); out.putShort(72, (short) 16); out.putShort(68, (short) 1002);
        out.putFloat(108, 352); out.putFloat(112, 1); out.putFloat(116, 0);
        out.putFloat(124, 0); out.putFloat(128, 0);
        out.position(352);
        for (int label : labels) {
            if (label < 0 || label > 65535) throw new IllegalArgumentException("标签值无效。");
            out.putShort((short) label);
        }
        return out.array();
    }

    public static byte[] gzipU16(int[] values) {
        ByteBuffer raw = ByteBuffer.allocate(Math.multiplyExact(values.length, 2)).order(ByteOrder.LITTLE_ENDIAN);
        for (int value : values) raw.putShort((short) value);
        return gzip(raw.array());
    }
    public static byte[] gzipU32(int[] values) {
        ByteBuffer raw = ByteBuffer.allocate(Math.multiplyExact(values.length, 4)).order(ByteOrder.LITTLE_ENDIAN);
        for (int value : values) raw.putInt(value);
        return gzip(raw.array());
    }
    public static int[] gunzipU16(byte[] compressed) {
        byte[] bytes = gunzip(compressed, MAX_VOXELS * 2);
        if (bytes.length % 2 != 0) throw new IllegalArgumentException("标签数据长度无效。");
        int[] values = new int[bytes.length / 2]; ByteBuffer raw = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
        for (int n = 0; n < values.length; n++) values[n] = Short.toUnsignedInt(raw.getShort());
        return values;
    }
    public static int[] gunzipU32(byte[] compressed) {
        byte[] bytes = gunzip(compressed, MAX_VOXELS * 4);
        if (bytes.length % 4 != 0) throw new IllegalArgumentException("权属数据长度无效。");
        int[] values = new int[bytes.length / 4]; ByteBuffer raw = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
        for (int n = 0; n < values.length; n++) values[n] = raw.getInt();
        return values;
    }
    public static byte[] gzip(byte[] raw) {
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            try (GZIPOutputStream zip = new GZIPOutputStream(out)) { zip.write(raw); }
            return out.toByteArray();
        } catch (IOException error) { throw new IllegalStateException("无法压缩标注。", error); }
    }
    public static byte[] gunzip(byte[] compressed) { return gunzip(compressed, MAX_RAW_BYTES); }
    public static byte[] gunzip(byte[] compressed, int limit) {
        try (GZIPInputStream input = new GZIPInputStream(new ByteArrayInputStream(compressed))) {
            ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] block = new byte[65536]; int n;
            while ((n = input.read(block)) != -1) {
                if ((long) out.size() + n > limit) throw new IllegalArgumentException("解压后的数据超过上限。");
                out.write(block, 0, n);
            }
            return out.toByteArray();
        } catch (IOException error) { throw new IllegalArgumentException("gzip 数据无效。", error); }
    }
}
