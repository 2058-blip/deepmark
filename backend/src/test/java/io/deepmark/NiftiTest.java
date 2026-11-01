package io.deepmark;

import org.junit.jupiter.api.Test;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

final class NiftiTest {
    private static byte[] source(ByteOrder order) {
        ByteBuffer b=ByteBuffer.allocate(368).order(order);
        b.putInt(0,348);b.putShort(40,(short)3);
        for(int a=0;a<3;a++){b.putShort(42+a*2,(short)2);b.putFloat(80+a*4,a==2?1.5f:1f);}
        b.putShort(70,(short)4);b.putShort(72,(short)16);b.putFloat(108,352);
        b.putShort(252,(short)1);b.putShort(254,(short)1);
        b.putFloat(280,-1);b.putFloat(292,20);b.putFloat(300,1);b.putFloat(308,-15);b.putFloat(320,1.5f);
        b.put(123,(byte)2);b.put(344,(byte)'n');b.put(345,(byte)'+');b.put(346,(byte)'1');
        return b.array();
    }

    @Test void exportKeepsGeometryAndEndianButUsesUnscaledUnsignedLabels() {
        for(ByteOrder order:List.of(ByteOrder.LITTLE_ENDIAN,ByteOrder.BIG_ENDIAN)){
            Nifti.Volume volume=Nifti.parse(source(order));
            int[] labels={0,1,300,0,65535,0,0,7};byte[] bytes=Nifti.export(volume,labels);
            ByteBuffer view=ByteBuffer.wrap(bytes).order(order);
            assertArrayEquals(new int[]{2,2,2},Nifti.parse(bytes).dims());
            assertEquals(512,view.getShort(70));assertEquals(1002,view.getShort(68));
            assertEquals(352f,view.getFloat(108));assertEquals(1f,view.getFloat(112));assertEquals(0f,view.getFloat(116));
            assertEquals(-1f,view.getFloat(280));assertEquals(20f,view.getFloat(292));assertEquals(-15f,view.getFloat(308));
            for(int i=0;i<labels.length;i++)assertEquals(labels[i],Short.toUnsignedInt(view.getShort(352+i*2)));
            assertArrayEquals(Arrays.copyOfRange(volume.header(),252,328),Arrays.copyOfRange(bytes,252,328));
        }
    }

    @Test void downloadedGzipAndBrowserMaskTransportAreIndependentOfSourceEndian() {
        Nifti.Volume volume=Nifti.parse(Nifti.gzip(source(ByteOrder.BIG_ENDIAN)));
        assertFalse(volume.littleEndian());assertEquals(8,volume.count());
        int[] labels={0,255,256,300,32768,65535};byte[] raw=Nifti.gunzip(Nifti.gzipU16(labels));
        assertEquals(0,raw[4]);assertEquals(1,raw[5]);
        assertArrayEquals(labels,Nifti.gunzipU16(Nifti.gzipU16(labels)));
        int[] owners={0,1,65536,1000000};assertArrayEquals(owners,Nifti.gunzipU32(Nifti.gzipU32(owners)));
    }

    @Test void invalidFilesAndUnboundedDecompressionAreRejected() {
        assertThrows(IllegalArgumentException.class,()->Nifti.parse(new byte[348]));
        byte[] truncated=Arrays.copyOf(source(ByteOrder.LITTLE_ENDIAN),356);
        assertThrows(IllegalArgumentException.class,()->Nifti.parse(truncated));
        byte[] fourD=source(ByteOrder.LITTLE_ENDIAN);ByteBuffer b=ByteBuffer.wrap(fourD).order(ByteOrder.LITTLE_ENDIAN);b.putShort(40,(short)4);b.putShort(48,(short)2);
        assertThrows(IllegalArgumentException.class,()->Nifti.parse(fourD));
        assertThrows(IllegalArgumentException.class,()->Nifti.gunzip(Nifti.gzip(new byte[1000]),100));
        assertThrows(IllegalArgumentException.class,()->Nifti.export(Nifti.parse(source(ByteOrder.LITTLE_ENDIAN)),new int[7]));
    }

    @Test void patchesUseTheExistingEightByteLittleEndianWireFormat() {
        String encoded=Collaboration.encodePatch(List.of(new int[]{3,65535,300},new int[]{7,300,0}));
        byte[] raw=java.util.Base64.getDecoder().decode(encoded);
        assertEquals(16,raw.length);assertEquals(3,raw[0]);assertEquals(44,raw[6]);assertEquals(1,raw[7]);
        List<int[]> decoded=Collaboration.decodePatch(encoded,8);
        assertArrayEquals(new int[]{3,65535,300},decoded.get(0));assertArrayEquals(new int[]{7,300,0},decoded.get(1));
        assertThrows(Collaboration.Failure.class,()->Collaboration.decodePatch(encoded,7));
        assertThrows(Collaboration.Failure.class,()->Collaboration.decodePatch(Collaboration.encodePatch(List.of(new int[]{3,0,1},new int[]{3,0,1})),8));
        assertThrows(Collaboration.Failure.class,()->Collaboration.decodePatch("not-base64",8));
    }

    @Test void geometryAndScaledPixelsAreValidatedBeforePublishingATask() {
        byte[] badQuaternion=source(ByteOrder.LITTLE_ENDIAN);
        ByteBuffer q=ByteBuffer.wrap(badQuaternion).order(ByteOrder.LITTLE_ENDIAN);
        q.putShort(254,(short)0);q.putFloat(256,Float.NaN);
        assertThrows(IllegalArgumentException.class,()->Nifti.parse(badQuaternion));
        byte[] singular=source(ByteOrder.LITTLE_ENDIAN);
        ByteBuffer s=ByteBuffer.wrap(singular).order(ByteOrder.LITTLE_ENDIAN);
        for(int n=0;n<12;n++)s.putFloat(280+n*4,0);
        assertThrows(IllegalArgumentException.class,()->Nifti.parse(singular));
        byte[] pixels=Arrays.copyOf(source(ByteOrder.LITTLE_ENDIAN),384);
        ByteBuffer p=ByteBuffer.wrap(pixels).order(ByteOrder.LITTLE_ENDIAN);
        p.putShort(70,(short)16);p.putShort(72,(short)32);p.putFloat(352,Float.NaN);
        assertThrows(IllegalArgumentException.class,()->Nifti.parse(pixels));
        p.putFloat(352,Float.MAX_VALUE);p.putFloat(112,2);
        assertThrows(IllegalArgumentException.class,()->Nifti.parse(pixels));
        // An unused malformed qform does not override a valid sform, matching NIfTI precedence.
        byte[] validSform=source(ByteOrder.LITTLE_ENDIAN);
        ByteBuffer.wrap(validSform).order(ByteOrder.LITTLE_ENDIAN).putFloat(256,Float.NaN);
        assertEquals(8,Nifti.parse(validSform).count());
    }
}
