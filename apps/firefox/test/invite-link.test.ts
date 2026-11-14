import { expect, it } from "vitest";
// @ts-expect-error: a plain .mjs script, no types.
import { presign } from "../scripts/invite-link.mjs";

it("signs like S3: AWS's own presigned URL example", () => {
  // docs.aws.amazon.com › AmazonS3 › sigv4-query-string-auth (example: GET examplebucket/test.txt).
  const url = presign({
    host: "examplebucket.s3.amazonaws.com",
    path: "/test.txt",
    region: "us-east-1",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    date: "20130524T000000Z",
    expires: 86400,
  });
  expect(url).toBe(
    "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
  );
});
