'use strict';

function mountOutput(FS, handle) {
  const node = FS.create('/output.mp4');
  const original = node.node_ops;
  node.node_ops = {
    getattr(file) {
      const stat = original.getattr(file);
      stat.size = handle.getSize();
      stat.blocks = Math.ceil(stat.size / 4096);
      return stat;
    },
    setattr(file, attributes) {
      const {size, ...metadata} = attributes;
      if (size !== undefined) handle.truncate(size);
      original.setattr(file, metadata);
    }
  };
  node.stream_ops = {
    read(stream, bytes, offset, length, position) {
      return handle.read(new Uint8Array(bytes.buffer, bytes.byteOffset + offset, length), {at: position});
    },
    write(stream, bytes, offset, length, position) {
      const written = handle.write(new Uint8Array(bytes.buffer, bytes.byteOffset + offset, length), {at: position});
      if (written !== length) throw Error('브라우저 저장 공간에 MP4를 모두 기록하지 못했습니다.');
      return written;
    },
    llseek(stream, offset, whence) {
      const position = offset + (whence === 1 ? stream.position : whence === 2 ? handle.getSize() : 0);
      if (position < 0) throw new FS.ErrnoError(28);
      return position;
    }
  };
}

const ENGINE_PARTS=[[16777216,'4ccba0c9cc7f019751a958ead3918cf51c9563ff2f8a76fb1f72ae492f66693b'],[15455203,'80e8b2ae7994e92102e048249ab0a6673480ca626c359b1d321b24f105f02e65']];
// The CDN copy must be byte-identical to the two original engine parts (SHA-256), otherwise it is never run.
async function verifyEngine(buffer){
 if(buffer.byteLength!==ENGINE_PARTS.reduce((n,[len])=>n+len,0))throw Error('변환 엔진 검증에 실패했습니다: 파일 크기가 원본과 다릅니다.');
 let offset=0;
 for(const [len,expected] of ENGINE_PARTS){
  const digest=await crypto.subtle.digest('SHA-256',new Uint8Array(buffer,offset,len));offset+=len;
  const actual=[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
  if(actual!==expected)throw Error('변환 엔진 검증에 실패했습니다: 내용이 원본과 다릅니다.');
 }
 return buffer;
}

async function loadCore(base, wasmModule) {
  // Reuse the engine the page already compiled: instantiation only, no second compile.
  if (wasmModule instanceof WebAssembly.Module) {
    try {
      let fail;
      const failed = new Promise((_, reject) => { fail = reject; });
      const core = createFFmpegCore({
        instantiateWasm(imports, receiveInstance) {
          WebAssembly.instantiate(wasmModule, imports)
            .then(instance => receiveInstance(instance, wasmModule), fail);
          return {};
        }
      });
      return await Promise.race([core, failed]);
    } catch (reuseError) { /* fall through to the self-contained path */ }
  }
  return createFFmpegCore({wasmBinary: await fetchWasm(base)});
}

async function fetchWasm(base) {
    // Local split parts first; if they are absent (e.g. self-hosted copy without the
    // two wasm files), fall back to the identical upstream build on jsDelivr.
    const CDN_WASM = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm';
    let wasmBinary;
    try {
      const parts = await Promise.all(['core.0.wasm', 'core.1.wasm'].map(async name => {
        const response = await fetch(new URL(name, base));
        if (!response.ok) throw Error('local wasm missing');
        return response.arrayBuffer();
      }));
      wasmBinary = await new Blob(parts).arrayBuffer();
    } catch (localError) {
      const response = await fetch(CDN_WASM);
      if (!response.ok) throw Error('소프트웨어 변환 엔진을 내려받지 못했습니다.');
      wasmBinary = await verifyEngine(await response.arrayBuffer());
    }
    return wasmBinary;
}

self.onmessage = async ({data: {file, outputHandle, mode, wasmModule}}) => {
  let access;
  try {
    const base = new URL('./', self.location.href);
    importScripts(new URL('ffmpeg-core.js', base).href);
    const core = await loadCore(base, wasmModule);
    const {FS} = core;
    if (!FS.filesystems.WORKERFS) throw Error('파일 읽기 모듈을 사용할 수 없습니다.');
    FS.mkdir('/input');
    FS.mount(FS.filesystems.WORKERFS, {blobs: [{name: 'source', data: file}]}, '/input');
    if (mode === 'probe') {
      const result = core.ffprobe('-v', 'error', '-show_entries',
        'stream=codec_name,codec_type:stream_disposition=attached_pic',
        '-of', 'json', '-o', '/streams.json', '/input/source');
      // This core leaves the return code at -1 when ffprobe writes successful JSON.
      if (result > 0) throw Error('영상과 오디오 코덱을 확인하지 못했습니다.');
      const {streams} = JSON.parse(FS.readFile('/streams.json', {encoding: 'utf8'}));
      const video = streams.filter(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
      const audio = streams.filter(stream => stream.codec_type === 'audio');
      self.postMessage({compatible: video.length === 1 && ['h264', 'hevc'].includes(video[0].codec_name)
        && audio.every(stream => stream.codec_name === 'aac')});
      return;
    }
    if (outputHandle) {
      access = await outputHandle.createSyncAccessHandle();
      mountOutput(FS, access);
    }
    let lastProgress = -1, log = '';
    core.setLogger(({message}) => {
      log = (log + '\n' + message).slice(-600);
    });
    core.setProgress(({progress}) => {
      if (!Number.isFinite(progress) || progress < 0) return;
      const percent = Math.min(99, Math.floor(progress * 100));
      if (percent <= lastProgress) return;
      lastProgress = percent;
      self.postMessage({percent});
    });
    self.postMessage({ready: true});
    const inputArgs = ['-hide_banner', '-loglevel', 'warning', '-i', '/input/source'];
    const outputArgs = mode === 'copy'
      ? ['-map', '0:V:0', '-map', '0:a?', '-c', 'copy']
      : ['-map', '0:V:0', '-map', '0:a:0?', '-vf', 'scale=ceil(iw/2)*2:ceil(ih/2)*2',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', '-ac', '2'];
    const result = core.exec(...inputArgs, ...outputArgs, '/output.mp4');
    if (result !== 0) throw Error('원본 영상 또는 오디오를 변환하지 못했습니다.' + (log ? '\n' + log.trim() : ''));
    if (access) {
      if (!access.getSize()) throw Error('변환 결과가 비어 있습니다.');
      access.flush();
      access.close();
      access = null;
      self.postMessage({stored: true});
      return;
    }
    const output = FS.readFile('/output.mp4');
    if (!output.length) throw Error('변환 결과가 비어 있습니다.');
    self.postMessage({output: output.buffer}, [output.buffer]);
  } catch (error) {
    access?.close();
    self.postMessage({error: error.message || '소프트웨어 변환에 실패했습니다.'});
  }
};
