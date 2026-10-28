import { describe, it, expect, vi } from 'vitest';
import { probeCloudProviders, type CloudProbeDeps } from '../src/services/cloudProviders';

function unconfigured() {
  return {};
}

describe('probeCloudProviders', () => {
  it('reports all three lanes unconfigured without any network I/O', async () => {
    const stsSend = vi.fn();
    const s3ListBuckets = vi.fn();
    const fetchImpl = vi.fn();
    const kaggleAuth = vi.fn();
    const lanes = await probeCloudProviders(unconfigured(), {
      stsSend, s3ListBuckets, fetchImpl: fetchImpl as unknown as typeof fetch, kaggleAuth,
    });

    expect(lanes.map((l) => l.id)).toEqual(['aws', 'cloudflare', 'kaggle']);
    for (const lane of lanes) {
      expect(lane.configured).toBe(false);
      expect(lane.up).toBeNull();
    }
    expect(stsSend).not.toHaveBeenCalled();
    expect(s3ListBuckets).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(kaggleAuth).not.toHaveBeenCalled();
  });

  it('verifies AWS with STS when a profile is configured', async () => {
    const stsSend = vi.fn(async () => ({ Arn: 'arn:aws:iam::006514117590:user/concordance-app', Account: '006514117590' }));
    const [aws] = await probeCloudProviders({ AWS_PROFILE: 'concordance', AWS_REGION: 'us-east-1' }, { stsSend });

    expect(stsSend).toHaveBeenCalledWith('us-east-1', 'concordance', expect.any(Number));
    expect(aws).toMatchObject({ id: 'aws', configured: true, up: true });
    expect(aws.detail).toContain('concordance-app');
    expect(aws.detail).toContain('006514117590');
  });

  it('reports the real AWS error, never as up', async () => {
    const stsSend = vi.fn(async () => { throw Object.assign(new Error('The security token is expired'), { name: 'ExpiredTokenException' }); });
    const [aws] = await probeCloudProviders({ AWS_ACCESS_KEY_ID: 'AKIATEST', AWS_SECRET_ACCESS_KEY: 'x' }, { stsSend });

    expect(aws.configured).toBe(true);
    expect(aws.up).toBe(false);
    expect(aws.detail).toContain('ExpiredTokenException');
    expect(aws.detail).toContain('expired');
  });

  it('reports R2 buckets when the S3 keys work even without a valid API token', async () => {
    const s3ListBuckets = vi.fn(async () => [{ Name: 'a' }, { Name: 'b' }, { Name: 'c' }]);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 401 }));
    const [, cloudflare] = await probeCloudProviders({
      CLOUDFLARE_ACCOUNT_ID: 'acct123',
      CLOUDFLARE_API_TOKEN: 'expired-token',
      R2_ACCESS_KEY_ID: 'r2key',
      R2_SECRET_ACCESS_KEY: 'r2secret',
    }, { s3ListBuckets, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(s3ListBuckets).toHaveBeenCalledWith(expect.objectContaining({
      region: 'auto',
      endpoint: 'https://acct123.r2.cloudflarestorage.com',
      accessKeyId: 'r2key',
    }));
    expect(cloudflare).toMatchObject({ id: 'cloudflare', configured: true, up: true });
    expect(cloudflare.detail).toContain('3 buckets');
    expect(cloudflare.detail).toContain('API token rejected');
  });

  it('is down when both the API token and R2 fail', async () => {
    const s3ListBuckets = vi.fn(async () => { throw new Error('SignatureDoesNotMatch'); });
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 403 }));
    const [, cloudflare] = await probeCloudProviders({
      CLOUDFLARE_ACCOUNT_ID: 'acct123',
      CLOUDFLARE_API_TOKEN: 'bad',
      R2_ACCESS_KEY_ID: 'r2key',
      R2_SECRET_ACCESS_KEY: 'r2secret',
    }, { s3ListBuckets, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(cloudflare.up).toBe(false);
    expect(cloudflare.detail).toContain('SignatureDoesNotMatch');
    expect(cloudflare.detail).toContain('403');
  });

  it('verifies Kaggle and counts visible kernels', async () => {
    const kaggleAuth = vi.fn(async () => true);
    const kaggleList = vi.fn(async () => [{ ref: 'a/b' }, { ref: 'c/d' }]);
    const [, , kaggle] = await probeCloudProviders({ KAGGLE_API_TOKEN: 'KGAT_test' }, { kaggleAuth, kaggleList });

    expect(kaggle).toMatchObject({ id: 'kaggle', configured: true, up: true });
    expect(kaggle.detail).toContain('2 kernels');
  });

  it('marks Kaggle down when the token is rejected', async () => {
    const kaggleAuth = vi.fn(async () => false);
    const [, , kaggle] = await probeCloudProviders({ KAGGLE_API_TOKEN: 'KGAT_bad' }, { kaggleAuth });

    expect(kaggle).toMatchObject({ configured: true, up: false });
    expect(kaggle.detail).toContain('401');
  });
});
