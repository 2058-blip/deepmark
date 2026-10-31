import type {GrayMode,RegionOutline} from './grayRegions.ts';
export class GrayRegionClient{
  private worker:Worker;private generation=0;private ready=false;private busy=false;private requestId=0;private wanted=-1;private selected=-1;private lastSeed=-1;private lastRegion='';private labels:Uint32Array|null=null;
  constructor(private preview:(outline:RegionOutline)=>void,private apply:(pixels:Uint32Array)=>void,private error:(message:string)=>void){
    this.worker=new Worker(new URL('./grayRegion.worker.ts',import.meta.url),{type:'module'});
    this.worker.onmessage=event=>{
      const m=event.data;if(m.generation!==this.generation)return;
      if(m.type==='ready'){this.ready=true;this.labels=m.labels?new Uint32Array(m.labels):null;this.send();return;}
      this.busy=false;
      if(m.type==='error'){this.error(m.message);this.selected=-1;}
      else if(m.type==='selected'){if(m.requestId===this.selected){this.selected=-1;this.apply(new Uint32Array(m.pixels));}}
      else if(m.type==='preview'&&m.seed===this.wanted){this.lastSeed=m.seed;this.lastRegion=m.regionId;this.preview(m.outline);}
      this.send();
    };
    this.worker.onerror=()=>this.error('灰度预览计算未能启动，请重新打开页面。');
  }
  prepare(data:Float32Array,width:number,height:number,mode:GrayMode,bandWidth:number){this.generation++;this.ready=false;this.busy=false;this.labels=null;this.lastRegion='';this.lastSeed=-1;this.selected=-1;const copy=data.slice().buffer;this.worker.postMessage({type:'prepare',generation:this.generation,data:copy,width,height,mode,bandWidth},[copy]);}
  hover(seed:number){this.wanted=seed;this.send();}
  select(seed:number){this.wanted=seed;this.selected=++this.requestId;this.send();}
  clear(){this.wanted=-1;this.lastSeed=-1;this.lastRegion='';this.selected=-1;}
  private send(){
    if(!this.ready||this.busy||this.wanted<0)return;
    if(this.selected<0&&(this.lastSeed===this.wanted||this.labels&&this.lastRegion===String(this.labels[this.wanted])))return;
    this.busy=true;this.worker.postMessage({type:this.selected>=0?'select':'preview',generation:this.generation,requestId:this.selected>=0?this.selected:++this.requestId,seed:this.wanted});
  }
  destroy(){this.worker.terminate();}
}
