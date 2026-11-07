const minimumZoom=.15,maximumZoom=12,sliderSteps=1000;
const logarithmicRange=Math.log(maximumZoom/minimumZoom);
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));

/** Convert a requested zoom into the native Ctrl-wheel input. The viewport keeps
 * ownership of zoom, pan and gesture cancellation; this only supplies its input. */
export function zoomWheelInput(current:number,target:number,rect:{left:number;top:number;width:number;height:number}):{ctrlKey:true;deltaY:number;clientX:number;clientY:number}|null{
  if(![current,target,rect.left,rect.top,rect.width,rect.height].every(Number.isFinite)||current<=0||target<=0||rect.width<=0||rect.height<=0)return null;
  const next=clamp(target,minimumZoom,maximumZoom);
  if(Math.abs(next-current)<=Number.EPSILON*Math.max(1,Math.abs(current),Math.abs(next))*4)return null;
  const clientX=rect.left+rect.width/2,clientY=rect.top+rect.height/2;
  if(!Number.isFinite(clientX)||!Number.isFinite(clientY))return null;
  // Native wheel zoom is current * exp(-deltaY * .002).
  const deltaY=-(Math.log(next)-Math.log(current))/.002;
  return{ctrlKey:true,deltaY,clientX,clientY};
}

/** Log spacing gives equal slider travel to equal multiplicative zoom changes. */
export function zoomToSlider(zoom:number):number{
  const bounded=Number.isFinite(zoom)?clamp(zoom,minimumZoom,maximumZoom):minimumZoom;
  return clamp(Math.log(bounded/minimumZoom)/logarithmicRange*sliderSteps,0,sliderSteps);
}

/** Invalid slider input falls back to the lower end; neither helper returns NaN. */
export function sliderToZoom(value:number):number{
  const bounded=Number.isFinite(value)?clamp(value,0,sliderSteps):0;
  return clamp(minimumZoom*Math.exp(bounded/sliderSteps*logarithmicRange),minimumZoom,maximumZoom);
}
