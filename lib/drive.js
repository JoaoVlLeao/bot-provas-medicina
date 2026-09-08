import { GoogleAuth } from 'google-auth-library';
const ALLOWED = new Set(['image/png','image/jpeg','image/webp']);
export class Drive {
  constructor({folderId, credentials, refreshToken, clientId, clientSecret}) {
    this.folderId=folderId;
    this.email=credentials?.client_email;
    this.configured=Boolean(folderId && (credentials || (refreshToken && clientId && clientSecret)));
    if(credentials) this.auth=new GoogleAuth({credentials,scopes:['https://www.googleapis.com/auth/drive.readonly']});
    if(refreshToken && clientId && clientSecret) this.auth=new GoogleAuth({credentials:{type:'authorized_user',client_id:clientId,client_secret:clientSecret,refresh_token:refreshToken},scopes:['https://www.googleapis.com/auth/drive.readonly']});
  }
  async request(url) {
    if(!this.configured) throw new Error('Falta autorizar o acesso à pasta do Google Drive.');
    const token=await this.auth.getAccessToken();
    const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(60000)});
    if(!response.ok) { const e=new Error(`Drive HTTP ${response.status}. ${response.status===404?'Pasta ou arquivo indisponível para a conta do bot.':response.status===403?'Verifique o acesso à pasta e a ativação da API do Drive.':'Não foi possível consultar o Drive.'}`); e.status=response.status; throw e; }
    return response;
  }
  async list() {
    const folder=await (await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(this.folderId)}?fields=id,mimeType&supportsAllDrives=true`)).json();
    if(folder.mimeType!=='application/vnd.google-apps.folder') throw new Error('O destino configurado não é uma pasta.');
    let pageToken; const files=[];
    do {
      const params=new URLSearchParams({q:`'${this.folderId}' in parents and trashed = false and (mimeType = 'image/png' or mimeType = 'image/jpeg' or mimeType = 'image/webp')`,fields:'nextPageToken,files(id,name,mimeType,createdTime,size)',pageSize:'1000',supportsAllDrives:'true',includeItemsFromAllDrives:'true'});
      if(pageToken) params.set('pageToken',pageToken);
      const page=await (await this.request(`https://www.googleapis.com/drive/v3/files?${params}`)).json();
      for(const f of page.files||[]) if(ALLOWED.has(f.mimeType)) files.push(f);
      pageToken=page.nextPageToken;
    } while(pageToken);
    return files;
  }
  async download(file) {
    const response=await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`);
    const chunks=[]; let size=0; const limit=10*1024*1024;
    if(Number(response.headers.get('content-length'))>limit) {await response.body.cancel();throw new Error('Imagem maior que 10 MB.');}
    for await(const chunk of response.body) {size+=chunk.length;if(size>limit) throw new Error('Imagem maior que 10 MB.');chunks.push(chunk);}
    if(!size) throw new Error('Imagem vazia.');
    return Buffer.concat(chunks);
  }
}
