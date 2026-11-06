/** A bounded FIFO of voxel addresses. Consumed blocks are recycled instead of
 * retaining every visited voxel in a growing JavaScript number array. */
export class VoxelFifo {
  private readonly blockLength:number;
  private readonly byteLimit:number;
  private readonly label:string;
  private allocated=0;
  private available:Uint32Array[]=[];
  private head:{data:Uint32Array;read:number;write:number;next?:VoxelFifo['head']}|undefined;
  private tail:VoxelFifo['head'];
  length=0;
  constructor(byteLimit:number,maximumEntries:number,blockLength=16384,label='动态区域生长'){
    if(!Number.isSafeInteger(byteLimit)||byteLimit<4||!Number.isSafeInteger(maximumEntries)||maximumEntries<1||!Number.isSafeInteger(blockLength)||blockLength<1)
      throw new Error('动态区域生长工作内存预算无效。');
    this.byteLimit=byteLimit;
    this.label=label;
    this.blockLength=Math.min(blockLength,maximumEntries,Math.floor(byteLimit/4));
  }
  get allocatedBytes(){return this.allocated;}
  push(value:number){
    if(!Number.isInteger(value)||value<0||value>0xffffffff)throw new Error('体素队列索引无效。');
    if(!this.tail||this.tail.write===this.tail.data.length){
      let data=this.available.pop();
      if(!data){
        const bytes=this.blockLength*4;
        if(this.allocated+bytes>this.byteLimit)throw new Error(this.label+'的待处理区域超过工作内存预算，请缩小处理范围或改用单层后重试。');
        try{data=new Uint32Array(this.blockLength);}catch{throw new Error('浏览器无法分配'+this.label+'队列内存，请缩小处理范围后重试。');}
        this.allocated+=data.byteLength;
      }
      const block={data,read:0,write:0};
      if(this.tail)this.tail.next=block;else this.head=block;
      this.tail=block;
    }
    this.tail.data[this.tail.write++]=value;this.length++;
  }
  shift():number|undefined{
    const block=this.head;if(!block||!this.length)return;
    const value=block.data[block.read++];this.length--;
    if(block.read===block.write){
      if(block.next){this.head=block.next;this.available.push(block.data);block.next=undefined;}
      else{block.read=block.write=0;}
    }
    return value;
  }
}
