package io.deepmark;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.io.RandomAccessFile;
import java.nio.*;
import java.nio.file.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class NiftiStreamingTest {
    @TempDir Path temporary;
    byte[] header(ByteOrder order,int x,int y,int z){
        ByteBuffer b=ByteBuffer.allocate(352).order(order);b.putInt(0,348).putShort(40,(short)3);
        int[] dims={x,y,z};for(int a=0;a<3;a++){b.putShort(42+a*2,(short)dims[a]);b.putFloat(80+a*4,1);}
        b.putShort(70,(short)2).putShort(72,(short)8).putFloat(108,352).putFloat(112,1);
        b.put(123,(byte)2).put(344,(byte)'n').put(345,(byte)'+').put(346,(byte)'1');return b.array();
    }
    @Test void streamedRawAndGzipRetainHeaderEndianAndValidateTruncationAndCrc()throws Exception{
        for(ByteOrder order:List.of(ByteOrder.LITTLE_ENDIAN,ByteOrder.BIG_ENDIAN)){
            byte[] bytes=Arrays.copyOf(header(order,4,4,2),384);bytes[352]=127;
            for(boolean zipped:List.of(false,true)){
                byte[] body=zipped?Nifti.gzip(bytes):bytes;Path file=temporary.resolve(order+"-"+zipped);Files.write(file,body);
                Nifti.Volume checked=Nifti.inspect(file);assertEquals(32,checked.count());assertArrayEquals(new int[]{4,4,2},checked.dims());assertEquals(order==ByteOrder.LITTLE_ENDIAN,checked.littleEndian());
                Files.write(file,Arrays.copyOf(body,body.length-(zipped?4:1)));assertThrows(IllegalArgumentException.class,()->Nifti.inspect(file));
                if(zipped){body[body.length-8]^=1;Files.write(file,body);assertThrows(IllegalArgumentException.class,()->Nifti.inspect(file));}
            }
        }
    }
    @Test void nativeInspectionAcceptsAboveLegacyVoxelLimitWithoutAllocatingTheVolume()throws Exception{
        Path file=temporary.resolve("large.nii");long count=512L*512*513;
        try(RandomAccessFile output=new RandomAccessFile(file.toFile(),"rw")){output.write(header(ByteOrder.LITTLE_ENDIAN,512,512,513));output.setLength(352+count);}
        assertTrue(count>Nifti.MAX_VOXELS);assertEquals(count,Nifti.inspect(file).count());
    }
    @Test void nonfiniteScaledFloatDataIsRejectedByStreamingInspector()throws Exception{
        byte[] bytes=Arrays.copyOf(header(ByteOrder.LITTLE_ENDIAN,1,1,1),356);ByteBuffer b=ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
        b.putShort(70,(short)16).putShort(72,(short)32).putFloat(352,Float.NaN);Path file=temporary.resolve("nan.nii.gz");Files.write(file,Nifti.gzip(bytes));
        assertThrows(IllegalArgumentException.class,()->Nifti.inspect(file));
    }
}
