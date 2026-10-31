import { demoJobSchema } from '@m2d/domain';
export async function handleDemoJob(
  job: { id: string; data: unknown },
  record: (id: string) => Promise<boolean>,
) {
  demoJobSchema.parse(job.data);
  return record(job.id);
}
