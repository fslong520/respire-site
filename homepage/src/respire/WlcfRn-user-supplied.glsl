// User-supplied source from https://www.shadertoy.com/view/WlcfRn
// User license designation: MIT. No author/copyright holder was supplied.
const float PI= 3.14159265359;
#define TYPE 4
vec3 saturate(vec3 a) { return clamp(a, 0.0, 1.0); }
vec2 saturate(vec2 a) { return clamp(a, 0.0, 1.0); }
float saturate(float a) { return clamp(a, 0.0, 1.0); }
mat3 rotate_x(float a){float sa = sin(a); float ca = cos(a); return mat3(vec3(1.,.0,.0), vec3(.0,ca,sa), vec3(.0,-sa,ca));}
mat3 rotate_y(float a){float sa = sin(a); float ca = cos(a); return mat3(vec3(ca,.0,sa), vec3(.0,1.,.0), vec3(-sa,.0,ca));}
mat3 rotate_z(float a){float sa = sin(a); float ca = cos(a); return mat3(vec3(ca,sa,.0), vec3(-sa,ca,.0), vec3(.0,.0,1.));}
const float TAU = 2.0 * PI;
float glow = 0.0;
float sdPlane(in vec3 p) { return p.y; }
float sdSphere(in vec3 p, float s) { return length(p) - s; }
float sdTorus(in vec3 p, in vec2 t) { return length(vec2(length(p.xz) - t.x, p.y)) - t.y; }
vec2 opUnion(vec2 d1, vec2 d2) { return d1.x < d2.x ? d1 : d2; }
float sdApple(vec3 p, float r) { p.y *= 0.95; p.xz *= 1.2; float k = 0.84 + 0.16 * smoothstep(-r, r, p.y); p.xz /= k; return sdTorus(p, vec2((0.9 / 1.25) * r, r))*0.3; }
float localTime = 0.0;
float smin(float a, float b, float k) { float h = clamp(0.5+0.5*(b-a)/k,0.0,1.0); return mix(b,a,h)-k*h*(1.0-h); }
vec2 matMin(vec2 a, vec2 b) { if(a.x<b.x)return a; else return b; }
float sdBox(vec3 p, vec3 radius) { vec3 dist=abs(p)-radius; return min(max(dist.x,max(dist.y,dist.z)),0.0)+length(max(dist,0.0)); }
mat2 mm2(in float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}
vec3 fold(in vec3 p) { const vec3 nc=vec3(-0.5,-0.809017,0.309017); for(int i=0;i<5;i++){p.xy=abs(p.xy);float t=2.*min(0.,dot(p,nc));p-=t*nc;}return p; }
float smax(float a,float b){const float k=2.;float h=1.-clamp(.5+.5*(b-a)/k,0.,1.);return mix(b,a,h)-k*h*(1.0-h);}
float tri(in float x){return abs(fract(x)-0.5)*2.;}
float solid(in vec3 p){
float time=iTime;vec3 fp=fold(p)-vec3(0.,0.,1.275);float d=mix(dot(fp,vec3(.618,0,1.)),length(p)-1.15,-3.6);
#if(TYPE==1)
d+=tri(fp.x*8.+fp.z*3.)*0.05+tri(fp.x*fp.y*40.+time*0.2)*0.07-0.17;d+=tri(fp.y*5.)*0.04;d*=0.9;
#elif(TYPE==2)
d*=0.7;d+=sin(time+fp.z*5.+sin(fp.x*20.*fp.y*8.)+1.1)*0.05-0.08;d+=sin(fp.x*20.*sin(fp.z*8.+time*0.2))*0.05;d+=sin(fp.x*20.*sin(fp.z*8.-time*0.3)*sin(fp.y*10.))*0.05;
#elif(TYPE==3)
d=smax(d+.5,-(d+sin(fp.y*20.+time+fp.z*10.)+1.5)*0.3)*.55;d+=sin(max(fp.x*1.3,max(fp.z*.5,fp.y*1.))*35.+time)*0.03;
#else
d=smax(d+.5,-(d+sin(fp.z*10.+sin(fp.x*20.*fp.y*9.)+1.1)*0.3-0.3))*.5;
#endif
return d*0.25;
}
vec2 toroidal(vec2 p,float r){return vec2(length(p.xy)-r,atan(p.y,p.x));}
mat2 rot(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}
float amod(inout vec2 p,float count){float an=TAU/count;float a=atan(p.y,p.x)+an/2.;float c=floor(a/an);c=mix(c,abs(c),step(count*.5,abs(c)));a=mod(a,an)-an/2.;p.xy=vec2(cos(a),sin(a))*length(p);return c;}
float sdCylinder(vec2 p,float r){return length(p)-r;}
float sdPlant(vec3 pos){float dist;float radius=2.;pos.y+=1.;pos.xyz=pos.zxy;vec3 p=pos;p.xy=toroidal(p.xy,radius);p.y*=2.;p.xz*=rot(p.y*2.+sin(p.y+iTime));float id=amod(p.xz,2.);p.x-=.2;p.xz*=rot(-p.y+iTime+sin(p.y-iTime*2.)*5.);id+=amod(p.xz,4.);p.x-=.1;dist=sdCylinder(p.xz,.04);return dist;}
vec2 scene(in vec3 position){vec3 p=position;p-=vec3(0.0,1.2,0.0);p/=vec3(0.8);float solid=sdPlant(p)*0.3;vec2 scene=opUnion(vec2(sdPlane(position),1.0),vec2(solid,12.0));return scene;}
vec4 boxmap(sampler2D sam,in vec3 p,in vec3 n,in float k){vec3 m=pow(abs(n),vec3(k));vec4 x=texture(sam,p.yz);vec4 y=texture(sam,p.zx);vec4 z=texture(sam,p.xy);return(x*m.x+y*m.y+z*m.z)/(m.x+m.y+m.z);}
float shadow(in vec3 origin,in vec3 direction){float hit=1.0;float t=0.02;for(int i=0;i<1000;i++){float h=scene(origin+direction*t).x;if(h<0.001)return 0.0;t+=h;hit=min(hit,10.0*h/t);if(t>=2.5)break;}return clamp(hit,0.0,1.0);}
vec2 traceRay(in vec3 origin,in vec3 direction){float material=-1.0;float t=0.02;for(int i=0;i<1000;i++){vec2 hit=scene(origin+direction*t);if(hit.x<0.002||t>20.0)break;t+=hit.x;material=hit.y;}if(t>20.0){material=-1.0;}return vec2(t,material);}
vec3 normal(in vec3 position){vec3 epsilon=vec3(0.001,0.0,0.0);vec3 n=vec3(scene(position+epsilon.xyy).x-scene(position-epsilon.xyy).x,scene(position+epsilon.yxy).x-scene(position-epsilon.yxy).x,scene(position+epsilon.yyx).x-scene(position-epsilon.yyx).x);return normalize(n);}
float pow5(float x){float x2=x*x;return x2*x2*x;}
float D_GGX(float linearRoughness,float NoH,const vec3 h){float oneMinusNoHSquared=1.0-NoH*NoH;float a=NoH*linearRoughness;float k=linearRoughness/(oneMinusNoHSquared+a*a);float d=k*k*(1.0/PI);return d;}
float V_SmithGGXCorrelated(float linearRoughness,float NoV,float NoL){float a2=linearRoughness*linearRoughness;float GGXV=NoL*sqrt((NoV-a2*NoV)*NoV+a2);float GGXL=NoV*sqrt((NoL-a2*NoL)*NoL+a2);return 0.5/(GGXV+GGXL);}
vec3 F_Schlick(const vec3 f0,float VoH){return f0+(vec3(1.0)-f0)*pow5(1.0-VoH);}
float F_Schlick(float f0,float f90,float VoH){return f0+(f90-f0)*pow5(1.0-VoH);}
float Fd_Burley(float linearRoughness,float NoV,float NoL,float LoH){float f90=0.5+2.0*linearRoughness*LoH*LoH;float lightScatter=F_Schlick(1.0,f90,NoL);float viewScatter=F_Schlick(1.0,f90,NoV);return lightScatter*viewScatter*(1.0/PI);}
float Fd_Lambert(){return 1.0/PI;}
vec3 Irradiance_SphericalHarmonics(const vec3 n){return max(vec3(0.754554516862612,0.748542953903366,0.790921515418539)+vec3(-0.083856548007422,0.092533500963210,0.322764661032516)*(n.y)+vec3(0.308152705331738,0.366796330467391,0.466698181299906)*(n.z)+vec3(-0.188884931542396,-0.277402551592231,-0.377844212327557)*(n.x),0.0);}
vec2 PrefilteredDFG_Karis(float roughness,float NoV){const vec4 c0=vec4(-1.0,-0.0275,-0.572,0.022);const vec4 c1=vec4(1.0,0.0425,1.040,-0.040);vec4 r=roughness*c0+c1;float a004=min(r.x*r.x,exp2(-9.28*NoV))*r.x+r.y;return vec2(-1.04,1.04)*a004+r.zw;}
vec3 Tonemap_ACES(const vec3 x){const float a=2.51,b=0.03,c=2.43,d=0.59,e=0.14;return(x*(a*x+b))/(x*(c*x+d)+e);}
vec3 OECF_sRGBFast(const vec3 linear){return pow(linear,vec3(1.0/2.2));}
vec3 hash3(vec2 p){vec3 q=vec3(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3)),dot(p,vec2(419.2,371.9)));return fract(sin(q)*43758.5453);}
float noise(vec2 x){vec2 p=floor(x);vec2 f=fract(x);return mix(mix(hash3(p+vec2(0.0,0.0)).x,hash3(p+vec2(1.0,0.0)).x,smoothstep(0.0,1.0,f.x)),mix(hash3(p+vec2(0.0,1.0)).x,hash3(p+vec2(1.0,1.0)).x,smoothstep(0.0,1.0,f.x)),smoothstep(0.0,1.0,f.y));}
vec2 getUV(vec3 pos){vec3 nor=normal(pos);float lon=atan(nor.x,nor.z)/3.14;float lat=acos(nor.y)/3.14;vec2 r=vec2(lat,lon);return r;}
vec3 render(in vec3 origin,in vec3 direction,out float distance,vec2 uv){
vec3 color=vec3(0.65,0.85,1.0)+direction.y*0.72;
vec2 hit=traceRay(origin,direction);distance=hit.x;float material=hit.y;
if(material>0.0){
vec3 position=origin+distance*direction;vec3 v=normalize(-direction);vec3 n=normal(position);vec3 l=normalize(vec3(0.6,0.7,-0.7));vec3 h=normalize(v+l);vec3 r=normalize(reflect(direction,n));float NoV=abs(dot(n,v))+1e-5;float NoL=saturate(dot(n,l));float NoH=saturate(dot(n,h));float LoH=saturate(dot(l,h));vec3 baseColor=vec3(0.0);float roughness=0.0;float metallic=0.0;float intensity=2.0;float indirectIntensity=0.64;
if(material<4.0){float f=mod(floor(6.0*position.z)+floor(6.0*position.x),2.0);baseColor=0.4+f*vec3(0.6);roughness=0.1;}else if(material<16.0){
// Original malformed expression intentionally retained in this reference file.
baseColor=vec3(255.0,0.0,0.0)/255.0218,165,32;
roughness=0.5;metallic=0.5;
}
float linearRoughness=roughness*roughness;vec3 diffuseColor=(1.0-metallic)*baseColor.rgb;vec3 f0=0.04*(1.0-metallic)+baseColor.rgb*metallic;float attenuation=shadow(position,l);float D=D_GGX(linearRoughness,NoH,h);float V=V_SmithGGXCorrelated(linearRoughness,NoV,NoL);vec3 F=F_Schlick(f0,LoH);vec3 Fr=(D*V)*F;vec3 Fd=diffuseColor*Fd_Burley(linearRoughness,NoV,NoL,LoH);color=Fd+Fr;color*=(intensity*attenuation*NoL)*vec3(0.98,0.92,0.89);vec3 indirectDiffuse=Irradiance_SphericalHarmonics(n)*Fd_Lambert();vec2 indirectHit=traceRay(position,r);vec3 indirectSpecular=vec3(0.65,0.85,1.0)+r.y*0.72;
if(indirectHit.y>0.0){if(indirectHit.y<4.0){vec3 indirectPosition=position+indirectHit.x*r;float f=mod(floor(6.0*indirectPosition.z)+floor(6.0*indirectPosition.x),2.0);indirectSpecular=0.4+f*vec3(0.6);}else if(indirectHit.y<16.0){indirectSpecular=vec3(0.3,0.0,0.0);}}
vec2 dfg=PrefilteredDFG_Karis(roughness,NoV);vec3 specularColor=f0*dfg.x+dfg.y;vec3 ibl=diffuseColor*indirectDiffuse+indirectSpecular*specularColor;color+=ibl*indirectIntensity;
}return color;
}
mat3 setCamera(in vec3 origin,in vec3 target,float rotation){vec3 forward=normalize(target-origin);vec3 orientation=vec3(sin(rotation),cos(rotation),0.0);vec3 left=normalize(cross(forward,orientation));vec3 up=normalize(cross(left,forward));return mat3(left,up,forward);}
// Original uninitialized global intentionally retained in this reference file.
vec2 glFragCoord;
vec3 Ray(float zoom){return vec3(glFragCoord.xy-iResolution.xy*.5,iResolution.x*zoom);}
vec3 Rotate(inout vec3 v,vec2 a){vec4 cs=vec4(cos(a.x),sin(a.x),cos(a.y),sin(a.y));v.yz=v.yz*cs.x+v.zy*cs.y*vec2(-1,1);v.xz=v.xz*cs.z+v.zx*cs.w*vec2(1,-1);vec3 p;p.xz=vec2(-cs.w,-cs.z)*cs.x;p.y=cs.y;return p;}
void mainImage(out vec4 fragColor,in vec2 fragCoord){
vec2 p=-1.0+2.0*fragCoord.xy/iResolution.xy;vec2 uv=fragCoord.xy/iResolution.xy;p.x*=iResolution.x/iResolution.y;vec3 ray=Ray(1.8);ray=normalize(ray);vec3 localRay=ray;vec2 mouse=vec2(-.1,iTime*.01);mouse=vec2(.5)-iMouse.yx/iResolution.yx;float T=iTime*.0;vec3 pos=3.0*Rotate(ray,vec2(.2,1.5-T)+vec2(-1.0,-7.0)*mouse);pos.y+=.06-pos.z*.02;pos.z+=pos.z*.2;pos.x+=.3;vec3 origin=vec3(0.0,2.0,0.0);vec3 target=vec3(0.0);origin+=pos;mat3 toWorld=setCamera(origin,target,0.0);vec3 direction=toWorld*normalize(vec3(p.xy,2.0));float distance;vec3 color=render(origin,direction,distance,getUV(origin+direction*traceRay(origin,direction).x));color=Tonemap_ACES(color);color=mix(color,0.8*vec3(0.7,0.8,1.0),1.0-exp2(-0.011*distance*distance));color=OECF_sRGBFast(color);fragColor=vec4(color,1.0);
}
