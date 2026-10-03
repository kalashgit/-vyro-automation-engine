// One shared queue supports up to 13 worker loops without 13 Railway services.
// Default remains one loop until the operator deliberately scales processing.
export function parseWorkerConcurrency(value) {
  if (value === undefined || value === null || value === '') return 1;
  if (typeof value !== 'string' || !/^(?:[1-9]|1[0-3])$/.test(value)) {
    throw new Error('WORKER_CONCURRENCY must be a whole number between 1 and 13');
  }
  return Number(value);
}
