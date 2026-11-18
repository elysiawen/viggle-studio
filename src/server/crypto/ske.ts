import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  pbkdf2 as pbkdf2Callback,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";
import { promisify } from "node:util";

/**
 * Sakura Encryptor（SKE）容器格式 v001 的 Node 实现，与参考项目
 * `SakuraEncryptor/ske_cli/crypto.py` 字节级兼容：
 *
 *   Header (55)  : MAGIC "SakuraEK" | VERSION "001" | SALT(16) | MASTER_IV(12) | SHMAC(16)
 *   Options (22) : KEY_CHECK(16) | KDF_ITERATIONS(5, BE) | FLAGS(1)
 *   Envelope     : "SKETH"(5) | NONCE(12) | THUMB_LEN(5, BE) | THUMB_CT
 *   Body         : 每 1 MiB 明文一块，AES-256-GCM 独立加密后追加 16 字节 tag
 *
 * AAD 固定为 header[0:39] + options，SHMAC 是 key 对整份内容的 HMAC-SHA256 前 16 字节。
 * 这里不生成缩略图信封（THUMB_LEN = 0），其余字段与参考实现一致。
 */

const MAGIC = Buffer.from("SakuraEK", "ascii");
const VERSION = Buffer.from("001", "ascii");
const THUMB_MAGIC = Buffer.from("SKETH", "ascii");

const SALT_SIZE = 16;
const IV_SIZE = 12;
const TAG_SIZE = 16;
const SHMAC_SIZE = 16;
const KEY_CHECK_SIZE = 16;
const KDF_ITERATIONS_SIZE = 5;
const OPTIONS_FLAGS_SIZE = 1;
const OPTIONS_SIZE = KEY_CHECK_SIZE + KDF_ITERATIONS_SIZE + OPTIONS_FLAGS_SIZE;
const HEADER_SIZE = MAGIC.length + VERSION.length + SALT_SIZE + IV_SIZE + SHMAC_SIZE;
const AAD_PREFIX_SIZE = HEADER_SIZE - SHMAC_SIZE;
const THUMB_NONCE_SIZE = 12;
const THUMB_HEADER_SIZE = THUMB_MAGIC.length + THUMB_NONCE_SIZE + KDF_ITERATIONS_SIZE;

const CHUNK_SIZE = 1024 * 1024;
const ENC_BLOCK_SIZE = CHUNK_SIZE + TAG_SIZE;

const KDF_ITERATIONS = 100_000;
const MAX_KDF_ITERATIONS = 2_000_000;
const KEY_CHECK_LABEL = Buffer.from("ske-keycheck", "utf8");
/** 文件名加密用的固定 salt；与参考实现保持一致，才能被 `ske decrypt` 识别。 */
const NAME_SALT = Buffer.from("skenamesalt-00-s", "utf8");
const NAME_IV_LABEL = Buffer.from("ske-name-iv", "utf8");

/** 加密文件统一使用 SKE 的扩展名后缀。 */
export const SKE_SUFFIX = ".ske";

const derive = promisify(pbkdf2Callback) as (
  password: string | Buffer,
  salt: Buffer,
  iterations: number,
  keylen: number,
  digest: string
) => Promise<Buffer>;

const keyCache = new Map<string, Buffer>();
const KEY_CACHE_LIMIT = 8;

/** PBKDF2-HMAC-SHA256 派生 256 位主密钥；按 salt + 迭代次数缓存，避免每次请求重复算。 */
export async function deriveKey(
  password: string,
  salt: Buffer,
  iterations: number = KDF_ITERATIONS
): Promise<Buffer> {
  if (password.length === 0) throw new Error("未配置加密主密码");
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_KDF_ITERATIONS) {
    throw new Error("加密文件的 KDF 迭代次数不受支持");
  }

  // 缓存键必须包含密码：只按 salt 缓存会让错误密码命中正确密钥。
  const passwordTag = createHash("sha256").update(password, "utf8").digest("hex").slice(0, 16);
  const cacheKey = `${passwordTag}:${salt.toString("hex")}:${iterations}`;
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;

  const key = await derive(password, salt, iterations, 32, "sha256");
  if (keyCache.size >= KEY_CACHE_LIMIT) keyCache.delete(keyCache.keys().next().value as string);
  keyCache.set(cacheKey, key);
  return key;
}

function keyCheck(key: Buffer): Buffer {
  return createHmac("sha256", key).update(KEY_CHECK_LABEL).digest().subarray(0, KEY_CHECK_SIZE);
}

function encodeOptions(key: Buffer, iterations: number): Buffer {
  const out = Buffer.alloc(OPTIONS_SIZE);
  keyCheck(key).copy(out, 0);
  out.writeUIntBE(iterations, KEY_CHECK_SIZE, KDF_ITERATIONS_SIZE);
  return out;
}

function encodeThumbLength(length: number): Buffer {
  const out = Buffer.alloc(KDF_ITERATIONS_SIZE);
  out.writeUIntBE(length, 0, KDF_ITERATIONS_SIZE);
  return out;
}

/** 块 nonce = master IV 与块序号（12 字节大端）逐字节异或。 */
function blockNonce(masterIv: Buffer, index: number): Buffer {
  const idx = Buffer.alloc(IV_SIZE);
  idx.writeUIntBE(index, IV_SIZE - 6, 6);
  const nonce = Buffer.alloc(IV_SIZE);
  for (let i = 0; i < IV_SIZE; i += 1) nonce[i] = masterIv[i] ^ idx[i];
  return nonce;
}

async function readExact(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) throw new Error("加密文件不完整（读取越界）");
    offset += bytesRead;
  }
  return buffer;
}

export interface SkePrefix {
  header: Buffer;
  options: Buffer;
  envelope: Buffer;
  salt: Buffer;
  masterIv: Buffer;
  iterations: number;
  thumbCt: Buffer;
  bodyOffset: number;
  aad: Buffer;
}

/** 读取 header / options / 缩略图信封，返回解密后续块所需的全部信息。 */
export async function readPrefix(handle: FileHandle): Promise<SkePrefix> {
  const header = await readExact(handle, HEADER_SIZE, 0);
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("不是 .ske 加密文件");
  if (!header.subarray(MAGIC.length, MAGIC.length + VERSION.length).equals(VERSION)) {
    throw new Error("不支持该 .ske 版本");
  }

  const salt = header.subarray(MAGIC.length + VERSION.length, AAD_PREFIX_SIZE - IV_SIZE);
  const masterIv = header.subarray(AAD_PREFIX_SIZE - IV_SIZE, AAD_PREFIX_SIZE);

  const options = await readExact(handle, OPTIONS_SIZE, HEADER_SIZE);
  if (options[OPTIONS_SIZE - 1] !== 0) throw new Error("不支持该 .ske 选项标志");
  const iterations = options.readUIntBE(KEY_CHECK_SIZE, KDF_ITERATIONS_SIZE);

  const envelopeHeader = await readExact(handle, THUMB_HEADER_SIZE, HEADER_SIZE + OPTIONS_SIZE);
  if (!envelopeHeader.subarray(0, THUMB_MAGIC.length).equals(THUMB_MAGIC)) {
    throw new Error("加密文件的缩略图信封已损坏");
  }
  const thumbLength = envelopeHeader.readUIntBE(THUMB_MAGIC.length + THUMB_NONCE_SIZE, KDF_ITERATIONS_SIZE);
  const thumbCt =
    thumbLength > 0
      ? await readExact(handle, thumbLength, HEADER_SIZE + OPTIONS_SIZE + THUMB_HEADER_SIZE)
      : Buffer.alloc(0);

  return {
    header,
    options,
    envelope: Buffer.concat([envelopeHeader, thumbCt]),
    salt,
    masterIv,
    iterations,
    thumbCt,
    bodyOffset: HEADER_SIZE + OPTIONS_SIZE + THUMB_HEADER_SIZE + thumbLength,
    aad: Buffer.concat([header.subarray(0, AAD_PREFIX_SIZE), options]),
  };
}

/** 用一个候选密码校验文件：失败抛错，成功返回派生出的 key。 */
export async function unlockPrefix(prefix: SkePrefix, password: string): Promise<Buffer> {
  const key = await deriveKey(password, prefix.salt, prefix.iterations);
  const expected = prefix.options.subarray(0, KEY_CHECK_SIZE);
  if (!timingSafeEqual(expected, keyCheck(key))) {
    throw new Error("主密码与该加密文件不匹配");
  }
  return key;
}

/** 明文总长度：整块数 × 1 MiB + 最后一块（去掉 16 字节 tag）。 */
export function plaintextSize(fileSize: number, bodyOffset: number): number {
  const body = fileSize - bodyOffset;
  if (body <= 0) return 0;
  const full = Math.floor(body / ENC_BLOCK_SIZE);
  const rest = body - full * ENC_BLOCK_SIZE;
  if (rest === 0) return full * CHUNK_SIZE;
  if (rest <= TAG_SIZE) throw new Error("加密文件尾部已损坏");
  return full * CHUNK_SIZE + (rest - TAG_SIZE);
}

async function readBlock(handle: FileHandle, prefix: SkePrefix, index: number): Promise<Buffer> {
  const { size } = await handle.stat();
  const offset = prefix.bodyOffset + index * ENC_BLOCK_SIZE;
  const length = Math.min(ENC_BLOCK_SIZE, size - offset);
  if (length <= TAG_SIZE) throw new Error("加密文件分块已损坏");
  return readExact(handle, length, offset);
}

function decryptBlock(key: Buffer, nonce: Buffer, block: Buffer, aad: Buffer): Buffer {
  const tag = block.subarray(block.length - TAG_SIZE);
  const body = block.subarray(0, block.length - TAG_SIZE);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

function encryptBlock(key: Buffer, nonce: Buffer, chunk: Buffer, aad: Buffer): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  return Buffer.concat([cipher.update(chunk), cipher.final(), cipher.getAuthTag()]);
}

/**
 * 加密整份文件。输出与 SKE v001 完全一致，可直接用 `ske decrypt` 还原。
 * 传入 thumbnail 时写入缩略图信封，官方 CLI 也能取出预览图。
 */
export async function encryptFile(
  src: string,
  dst: string,
  password: string,
  thumbnail?: Buffer | null
): Promise<void> {
  const salt = randomBytes(SALT_SIZE);
  const masterIv = randomBytes(IV_SIZE);
  const key = await deriveKey(password, salt, KDF_ITERATIONS);

  const headerPrefix = Buffer.concat([MAGIC, VERSION, salt, masterIv]);
  const options = encodeOptions(key, KDF_ITERATIONS);
  const aad = Buffer.concat([headerPrefix, options]);

  // 缩略图独立用 AES-GCM 加密：AAD 绑定 header/options 与信封长度，
  // 与参考实现 `thumb_aad = aad + THUMB_MAGIC + len(ct)` 完全一致。
  const thumbNonce = randomBytes(THUMB_NONCE_SIZE);
  let thumbCt = Buffer.alloc(0);
  if (thumbnail?.length) {
    const thumbAad = Buffer.concat([
      aad,
      THUMB_MAGIC,
      encodeThumbLength(thumbnail.length + TAG_SIZE),
    ]);
    const thumbCipher = createCipheriv("aes-256-gcm", key, thumbNonce);
    thumbCipher.setAAD(thumbAad);
    thumbCt = Buffer.concat([
      thumbCipher.update(thumbnail),
      thumbCipher.final(),
      thumbCipher.getAuthTag(),
    ]);
  }
  const envelope = Buffer.concat([
    THUMB_MAGIC,
    thumbNonce,
    encodeThumbLength(thumbCt.length),
    thumbCt,
  ]);

  const mac = createHmac("sha256", key);
  mac.update(headerPrefix);
  mac.update(options);
  mac.update(envelope);

  const fin = await open(src, "r");
  const fout = await open(dst, "w");
  try {
    await fout.write(Buffer.alloc(HEADER_SIZE));
    await fout.write(options);
    await fout.write(envelope);

    const chunk = Buffer.alloc(CHUNK_SIZE);
    let position = 0;
    let index = 0;
    for (;;) {
      const { bytesRead } = await fin.read(chunk, 0, CHUNK_SIZE, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const block = encryptBlock(key, blockNonce(masterIv, index), chunk.subarray(0, bytesRead), aad);
      await fout.write(block);
      mac.update(block);
      index += 1;
    }

    const header = Buffer.concat([headerPrefix, mac.digest().subarray(0, SHMAC_SIZE)]);
    await fout.write(header, 0, HEADER_SIZE, 0);
  } finally {
    await fin.close();
    await fout.close();
  }
}

/** 解密指定明文区间（闭区间），只读取覆盖到的分块。 */
export async function decryptRange(
  handle: FileHandle,
  prefix: SkePrefix,
  key: Buffer,
  start: number,
  end: number
): Promise<Buffer> {
  if (end < start) return Buffer.alloc(0);
  const firstBlock = Math.floor(start / CHUNK_SIZE);
  const lastBlock = Math.floor(end / CHUNK_SIZE);
  const parts: Buffer[] = [];

  for (let index = firstBlock; index <= lastBlock; index += 1) {
    const plain = decryptBlock(key, blockNonce(prefix.masterIv, index), await readBlock(handle, prefix, index), prefix.aad);
    const blockStart = index * CHUNK_SIZE;
    const from = Math.max(0, start - blockStart);
    const to = Math.min(plain.length, end - blockStart + 1);
    if (to > from) parts.push(plain.subarray(from, to));
  }
  return Buffer.concat(parts);
}

/** 整份解密到内存；只用于封面这类小文件。 */
export async function decryptAll(handle: FileHandle, prefix: SkePrefix, key: Buffer): Promise<Buffer> {
  const { size } = await handle.stat();
  const total = plaintextSize(size, prefix.bodyOffset);
  return decryptRange(handle, prefix, key, 0, Math.max(0, total - 1));
}

/** 文件是否内嵌了缩略图（信封长度小于 tag 说明没有）。 */
export function hasThumbnail(prefix: SkePrefix): boolean {
  return prefix.thumbCt.length > TAG_SIZE;
}

/**
 * 解密信封里的缩略图；没有缩略图时返回 null。
 * AAD 规则与参考实现的 `decrypt_thumbnail` 一致：aad + "SKETH" + 密文长度。
 */
export function decryptThumbnail(prefix: SkePrefix, key: Buffer): Buffer | null {
  if (!hasThumbnail(prefix)) return null;
  const nonce = prefix.envelope.subarray(
    THUMB_MAGIC.length,
    THUMB_MAGIC.length + THUMB_NONCE_SIZE
  );
  const aad = Buffer.concat([prefix.aad, THUMB_MAGIC, encodeThumbLength(prefix.thumbCt.length)]);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(prefix.thumbCt.subarray(prefix.thumbCt.length - TAG_SIZE));
  return Buffer.concat([
    decipher.update(prefix.thumbCt.subarray(0, prefix.thumbCt.length - TAG_SIZE)),
    decipher.final(),
  ]);
}

/**
 * 顺序解密整份文件并输出明文流，用于不支持 Range 的播放请求。
 * 流结束（或出错）时关闭文件句柄。
 */
export function createDecryptStream(handle: FileHandle, prefix: SkePrefix, key: Buffer): Readable {
  async function* blocks(): AsyncGenerator<Buffer> {
    try {
      const { size } = await handle.stat();
      const body = size - prefix.bodyOffset;
      const count = Math.ceil(body / ENC_BLOCK_SIZE);
      for (let index = 0; index < count; index += 1) {
        yield decryptBlock(key, blockNonce(prefix.masterIv, index), await readBlock(handle, prefix, index), prefix.aad);
      }
    } finally {
      await handle.close();
    }
  }
  return Readable.from(blocks());
}

// ---------------- 文件名加密（SKE 确定性命名） ----------------

/**
 * 文件名必须用 SKE 的确定性命名加密：官方 CLI 解密时会先对 `<token>.ske`
 * 的 token 做 decrypt_name 还原原名，直接用 `<任务ID>.mp4.ske` 会被判为非法。
 */
function nameIvAndKey(key: Buffer): Buffer {
  return createHmac("sha256", key).update(NAME_IV_LABEL).digest().subarray(0, IV_SIZE);
}

export async function encryptName(name: string, password: string): Promise<string> {
  const key = await deriveKey(password, NAME_SALT, KDF_ITERATIONS);
  const cipher = createCipheriv("aes-256-gcm", key, nameIvAndKey(key));
  const ct = Buffer.concat([
    cipher.update(Buffer.from(name, "utf8")),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return ct.toString("base64url");
}

export async function decryptName(token: string, password: string): Promise<string> {
  const key = await deriveKey(password, NAME_SALT, KDF_ITERATIONS);
  const decipher = createDecipheriv("aes-256-gcm", key, nameIvAndKey(key));
  const raw = Buffer.from(token, "base64url");
  decipher.setAuthTag(raw.subarray(raw.length - TAG_SIZE));
  const plain = Buffer.concat([decipher.update(raw.subarray(0, raw.length - TAG_SIZE)), decipher.final()]);
  return plain.toString("utf8");
}

/** 打开并解锁一个 .ske 文件；调用方负责关闭返回的 handle。 */
export async function openEncryptedFile(
  path: string,
  password: string
): Promise<{ handle: FileHandle; prefix: SkePrefix; key: Buffer }> {
  const handle = await open(path, "r");
  try {
    const prefix = await readPrefix(handle);
    const key = await unlockPrefix(prefix, password);
    return { handle, prefix, key };
  } catch (err) {
    await handle.close();
    throw err;
  }
}
