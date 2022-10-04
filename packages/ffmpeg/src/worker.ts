/// <reference no-default-lib="true" />
/// <reference lib="esnext" />
/// <reference lib="webworker" />

import type { FFmpegCoreModule, FFmpegCoreModuleFactory } from "@ffmpeg/types";
import type {
  FFMessageEvent,
  FFMessageLoadConfig,
  FFMessageExecData,
  FFMessageWriteFileData,
  FFMessageReadFileData,
  FFMessageDeleteFileData,
  FFMessageRenameData,
  FFMessageCreateDirData,
  FFMessageListDirData,
  FFMessageDeleteDirData,
  CallbackData,
  IsFirst,
  OK,
  ExitCode,
  FFFSPaths,
  FileData,
} from "./types";
import { toBlobURL } from "./utils";
import {
  CORE_URL,
  FFMessageType,
  MIME_TYPE_JAVASCRIPT,
  MIME_TYPE_WASM,
} from "./const";
import { ERROR_UNKNOWN_MESSAGE_TYPE, ERROR_NOT_LOADED } from "./errors";

declare global {
  interface WorkerGlobalScope {
    createFFmpegCore: FFmpegCoreModuleFactory;
  }
}

let ffmpeg: FFmpegCoreModule;

const load = async ({
  coreURL: _coreURL = CORE_URL,
  wasmURL: _wasmURL,
  workerURL: _workerURL,
  blob = true,
  thread = false,
}: FFMessageLoadConfig): Promise<IsFirst> => {
  const first = !ffmpeg;
  let coreURL = _coreURL;
  let wasmURL = _wasmURL ? _wasmURL : _coreURL.replace(/.js$/g, ".wasm");
  let workerURL = _workerURL
    ? _workerURL
    : _coreURL.replace(/.js$/g, ".worker.js");

  if (blob) {
    coreURL = await toBlobURL(coreURL, MIME_TYPE_JAVASCRIPT, (data) =>
      self.postMessage({ type: FFMessageType.DOWNLOAD, data })
    );
    wasmURL = await toBlobURL(wasmURL, MIME_TYPE_WASM, (data) =>
      self.postMessage({ type: FFMessageType.DOWNLOAD, data })
    );
    if (thread) {
      workerURL = await toBlobURL(workerURL, MIME_TYPE_JAVASCRIPT, (data) =>
        self.postMessage({ type: FFMessageType.DOWNLOAD, data })
      );
    }
  }

  importScripts(coreURL);
  ffmpeg = await (self as WorkerGlobalScope).createFFmpegCore({
    // Fix `Overload resolution failed.` when using multi-threaded ffmpeg-core.
    mainScriptUrlOrBlob: coreURL,
    locateFile: (path: string, prefix: string): string => {
      if (path.endsWith(".wasm")) return wasmURL;
      if (path.endsWith(".worker.js")) return workerURL;
      return prefix + path;
    },
  });
  ffmpeg.setLogger((data) =>
    self.postMessage({ type: FFMessageType.LOG, data })
  );
  ffmpeg.setProgress((progress: number) =>
    self.postMessage({ type: FFMessageType.PROGRESS, data: { progress } })
  );
  return first;
};

const exec = ({ args, timeout = -1 }: FFMessageExecData): ExitCode => {
  ffmpeg.setTimeout(timeout);
  ffmpeg.exec(...args);
  const ret = ffmpeg.ret;
  ffmpeg.reset();
  return ret;
};

const writeFile = ({ path, data }: FFMessageWriteFileData): OK => {
  ffmpeg.FS.writeFile(path, data);
  return true;
};

const readFile = ({ path, encoding }: FFMessageReadFileData): FileData =>
  ffmpeg.FS.readFile(path, { encoding });

// TODO: check if deletion works.
const deleteFile = ({ path }: FFMessageDeleteFileData): OK => {
  ffmpeg.FS.unlink(path);
  return true;
};

const rename = ({ oldPath, newPath }: FFMessageRenameData): OK => {
  ffmpeg.FS.rename(oldPath, newPath);
  return true;
};

// TODO: check if creation works.
const createDir = ({ path }: FFMessageCreateDirData): OK => {
  ffmpeg.FS.mkdir(path);
  return true;
};

const listDir = ({ path }: FFMessageListDirData): FFFSPaths => {
  return ffmpeg.FS.readdir(path);
};

// TODO: check if deletion works.
const deleteDir = ({ path }: FFMessageDeleteDirData): OK => {
  ffmpeg.FS.rmdir(path);
  return true;
};

self.onmessage = async ({
  data: { id, type, data: _data },
}: FFMessageEvent): Promise<void> => {
  const trans = [];
  let data: CallbackData;
  try {
    if (type !== FFMessageType.LOAD && !ffmpeg) throw ERROR_NOT_LOADED;

    switch (type) {
      case FFMessageType.LOAD:
        data = await load(_data as FFMessageLoadConfig);
        break;
      case FFMessageType.EXEC:
        data = exec(_data as FFMessageExecData);
        break;
      case FFMessageType.WRITE_FILE:
        data = writeFile(_data as FFMessageWriteFileData);
        break;
      case FFMessageType.READ_FILE:
        data = readFile(_data as FFMessageReadFileData);
        break;
      case FFMessageType.DELETE_FILE:
        data = deleteFile(_data as FFMessageDeleteFileData);
        break;
      case FFMessageType.RENAME:
        data = rename(_data as FFMessageRenameData);
        break;
      case FFMessageType.CREATE_DIR:
        data = createDir(_data as FFMessageCreateDirData);
        break;
      case FFMessageType.LIST_DIR:
        data = listDir(_data as FFMessageListDirData);
        break;
      case FFMessageType.DELETE_DIR:
        data = deleteDir(_data as FFMessageDeleteDirData);
        break;
      default:
        throw ERROR_UNKNOWN_MESSAGE_TYPE;
    }
  } catch (e) {
    self.postMessage({ id, type: FFMessageType.ERROR, data: e as Error });
    return;
  }
  if (data instanceof Uint8Array) {
    trans.push(data.buffer);
  }
  self.postMessage({ id, type, data }, trans);
};
