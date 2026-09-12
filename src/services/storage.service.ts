import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ConfigurationError } from '../types/exceptions';

/**
 * Wraps all Cloudflare R2 (S3-compatible) operations.
 *
 * Boot-safety: this class reads NO environment at import or construction time.
 * The S3 client and bucket are resolved lazily on the first method call. If the
 * R2_* credentials are absent, that first call throws ConfigurationError
 * ('R2 storage not configured') — the server still boots and every non-storage
 * route keeps working; only storage operations fail, with a clean 503.
 */
class StorageService {
  private client: S3Client | null = null;
  private bucketName: string | null = null;

  /** True when the three R2 credentials needed to sign requests are present. */
  static isConfigured(): boolean {
    return Boolean(
      process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY,
    );
  }

  private config(): { client: S3Client; bucket: string } {
    if (this.client && this.bucketName) {
      return { client: this.client, bucket: this.bucketName };
    }
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    if (!accountId || !accessKeyId || !secretAccessKey) {
      throw new ConfigurationError('R2 storage not configured');
    }
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });
    this.bucketName = process.env.R2_BUCKET_NAME || 'hpx-eigen-mandates';
    return { client: this.client, bucket: this.bucketName };
  }

  async generateUploadUrl(
    key: string,
    contentType: string,
    maxSizeBytes: number,
    expiresIn: number = 900,
  ): Promise<{ url: string; expiresAt: Date }> {
    const { client, bucket } = this.config();
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: maxSizeBytes,
    });
    const url = await getSignedUrl(client, command, { expiresIn });
    return { url, expiresAt: new Date(Date.now() + expiresIn * 1000) };
  }

  async generateViewUrl(
    key: string,
    expiresIn: number = 900,
  ): Promise<{ url: string; expiresAt: Date }> {
    const { client, bucket } = this.config();
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    });
    const url = await getSignedUrl(client, command, { expiresIn });
    return { url, expiresAt: new Date(Date.now() + expiresIn * 1000) };
  }

  async headObject(key: string): Promise<{ exists: boolean; contentLength?: number; contentType?: string }> {
    const { client, bucket } = this.config();
    try {
      const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { exists: true, contentLength: res.ContentLength, contentType: res.ContentType };
    } catch (err: any) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        return { exists: false };
      }
      throw err;
    }
  }

  async deleteObject(key: string): Promise<void> {
    const { client, bucket } = this.config();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  async copyObject(sourceKey: string, destKey: string): Promise<void> {
    const { client, bucket } = this.config();
    await client.send(new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${bucket}/${sourceKey}`,
      Key: destKey,
    }));
  }
}

export const storageService = new StorageService();
export const isStorageConfigured = StorageService.isConfigured;
