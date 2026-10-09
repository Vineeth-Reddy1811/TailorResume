const databaseName = "tailorresume-local-session";
const storeName = "drafts";
const metadataStoreName = "metadata";
const draftKey = "current";
const generationKey = "generation";
const revisionKey = "revision";
const channelName = "tailorresume-local-session-changes";
const maxResumeSize = 15 * 1024 * 1024;
const maxJobDescriptionLength = 30_000;
export const localSessionRetentionMs = 7 * 24 * 60 * 60 * 1000;

interface StoredDraft {
  resume: Blob | null;
  fileName: string | null;
  fileType: string | null;
  lastModified: number | null;
  jobDescription: string;
  savedAt: number;
}

export interface LocalDraft {
  resume: File | null;
  jobDescription: string;
}

let writeQueue: Promise<unknown> = Promise.resolve();
let observedGeneration = 0;
let observedRevision = 0;
let localRevisionTail: Promise<number> = Promise.resolve(0);
const draftChannel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(channelName);

draftChannel?.addEventListener("message", (event: MessageEvent<{ type?: string; generation?: number; revision?: number }>) => {
  if (event.data?.type === "cleared" && Number.isSafeInteger(event.data.generation)) {
    observedGeneration = event.data.generation as number;
    if (Number.isSafeInteger(event.data.revision)) {
      observedRevision = event.data.revision as number;
      localRevisionTail = Promise.resolve(observedRevision);
    }
  }
});

export function subscribeToLocalDraftClear(onClear: () => void): () => void {
  if (!draftChannel) return () => undefined;
  const listener = (event: MessageEvent<{ type?: string }>) => {
    if (event.data?.type === "cleared") onClear();
  };
  draftChannel.addEventListener("message", listener);
  return () => draftChannel.removeEventListener("message", listener);
}

function enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
  const queued = writeQueue.then(operation, operation);
  writeQueue = queued.then(() => undefined, () => undefined);
  return queued;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("This browser does not support local draft storage."));
      return;
    }
    const request = window.indexedDB.open(databaseName, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName);
      if (!request.result.objectStoreNames.contains(metadataStoreName)) request.result.createObjectStore(metadataStoreName);
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(new Error("Could not open the local draft store."));
    request.onblocked = () => reject(new Error("The local draft store is busy in another tab. Close the other TailorResume tab and try again."));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Could not read the local draft."));
  });
}

export async function loadLocalDraft(): Promise<LocalDraft> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction([storeName, metadataStoreName], "readonly");
    const [draftValue, generationValue, revisionValue] = await Promise.all([
      requestResult(transaction.objectStore(storeName).get(draftKey)),
      requestResult(transaction.objectStore(metadataStoreName).get(generationKey)),
      requestResult(transaction.objectStore(metadataStoreName).get(revisionKey)),
    ]);
    observedGeneration = Number.isSafeInteger(generationValue) ? generationValue as number : 0;
    observedRevision = Number.isSafeInteger(revisionValue) ? revisionValue as number : 0;
    localRevisionTail = Promise.resolve(observedRevision);
    const stored = draftValue as StoredDraft | undefined;
    if (!stored) return { resume: null, jobDescription: "" };

    const isExpired = !Number.isFinite(stored.savedAt) || Date.now() - stored.savedAt > localSessionRetentionMs;
    const validDescription = typeof stored.jobDescription === "string" && stored.jobDescription.length <= maxJobDescriptionLength;
    const validResume = stored.resume === null || (
      stored.resume instanceof Blob
      && stored.resume.size <= maxResumeSize
      && typeof stored.fileName === "string"
      && stored.fileName.toLowerCase().endsWith(".docx")
      && Number.isFinite(stored.lastModified)
    );
    if (isExpired || !validDescription || !validResume) {
      const deleted = await deleteDraftIfUnchanged(database, observedGeneration, observedRevision);
      if (!deleted) return loadLocalDraft();
      return { resume: null, jobDescription: "" };
    }

    const resume = stored.resume && stored.fileName
      ? new File([stored.resume], stored.fileName, { type: stored.fileType || "application/vnd.openxmlformats-officedocument.wordprocessingml.document", lastModified: stored.lastModified ?? Date.now() })
      : null;
    return { resume, jobDescription: stored.jobDescription };
  } finally {
    database.close();
  }
}

function deleteDraftIfUnchanged(database: IDBDatabase, expectedGeneration: number, expectedRevision: number): Promise<boolean> {
  const transaction = database.transaction([storeName, metadataStoreName], "readwrite");
  const draftStore = transaction.objectStore(storeName);
  const metadataStore = transaction.objectStore(metadataStoreName);
  let changed = false;
  let nextGeneration = expectedGeneration + 1;
  let nextRevision = expectedRevision + 1;
  const generationRequest = metadataStore.get(generationKey);
  generationRequest.onsuccess = () => {
    const currentGeneration = Number.isSafeInteger(generationRequest.result) ? generationRequest.result as number : 0;
    const revisionRequest = metadataStore.get(revisionKey);
    revisionRequest.onsuccess = () => {
      const currentRevision = Number.isSafeInteger(revisionRequest.result) ? revisionRequest.result as number : 0;
      if (currentGeneration !== expectedGeneration || currentRevision !== expectedRevision) {
        changed = true;
        transaction.abort();
        return;
      }
      nextGeneration = currentGeneration + 1;
      nextRevision = currentRevision + 1;
      draftStore.delete(draftKey);
      metadataStore.put(nextGeneration, generationKey);
      metadataStore.put(nextRevision, revisionKey);
    };
    revisionRequest.onerror = () => transaction.abort();
  };
  generationRequest.onerror = () => transaction.abort();

  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      observedGeneration = nextGeneration;
      observedRevision = nextRevision;
      localRevisionTail = Promise.resolve(nextRevision);
      draftChannel?.postMessage({ type: "cleared", generation: nextGeneration, revision: nextRevision });
      resolve(true);
    };
    transaction.onabort = () => changed ? resolve(false) : reject(new Error("Could not clear the expired local draft."));
    transaction.onerror = () => reject(new Error("Could not clear the expired local draft."));
  });
}

export function saveLocalDraft(resume: File | null, jobDescription: string): Promise<void> {
  if (jobDescription.length > maxJobDescriptionLength || (resume && resume.size > maxResumeSize)) {
    return Promise.reject(new Error("This draft is larger than the local session limit and was not saved."));
  }
  const expectedClearGeneration = observedGeneration;
  const operation = localRevisionTail.then((expectedRevision) => enqueueWrite(async () => {
    const database = await openDatabase();
    try {
      const transaction = database.transaction([storeName, metadataStoreName], "readwrite");
      const draftStore = transaction.objectStore(storeName);
      const metadataStore = transaction.objectStore(metadataStoreName);
      let staleGeneration = false;
      let staleRevision = false;
      let resultingGeneration = expectedClearGeneration;
      let resultingRevision = expectedRevision;
      const generationRequest = metadataStore.get(generationKey);
      await new Promise<void>((resolve, reject) => {
        generationRequest.onsuccess = () => {
          const currentGeneration = Number.isSafeInteger(generationRequest.result) ? generationRequest.result as number : 0;
          if (currentGeneration !== expectedClearGeneration) {
            staleGeneration = true;
            transaction.abort();
            return;
          }
          const revisionRequest = metadataStore.get(revisionKey);
          revisionRequest.onsuccess = () => {
            const currentRevision = Number.isSafeInteger(revisionRequest.result) ? revisionRequest.result as number : 0;
            if (currentRevision !== expectedRevision) {
              staleRevision = true;
              transaction.abort();
              return;
            }
            resultingRevision = currentRevision + 1;
            if (resume || jobDescription) {
              const stored: StoredDraft = {
                resume: resume ? new Blob([resume], { type: resume.type }) : null,
                fileName: resume?.name ?? null,
                fileType: resume?.type ?? null,
                lastModified: resume?.lastModified ?? null,
                jobDescription,
                savedAt: Date.now(),
              };
              draftStore.put(stored, draftKey);
            } else {
              resultingGeneration = currentGeneration + 1;
              draftStore.delete(draftKey);
              metadataStore.put(resultingGeneration, generationKey);
            }
            metadataStore.put(resultingRevision, revisionKey);
          };
          revisionRequest.onerror = () => transaction.abort();
        };
        generationRequest.onerror = () => transaction.abort();
        transaction.oncomplete = () => {
          observedGeneration = resultingGeneration;
          observedRevision = resultingRevision;
          if (!resume && !jobDescription) draftChannel?.postMessage({ type: "cleared", generation: resultingGeneration, revision: resultingRevision });
          resolve();
        };
        transaction.onabort = () => reject(new Error(staleGeneration ? "This saved session was cleared in another tab. Reload to continue." : staleRevision ? "This draft changed in another tab. Reload before saving." : "Could not save the local draft."));
        transaction.onerror = () => reject(new Error("Could not save the local draft."));
      });
      return resultingRevision;
    } finally {
      database.close();
    }
  }));
  localRevisionTail = operation.then((revision) => revision, () => observedRevision);
  return operation.then(() => undefined);
}

export function clearLocalDraft(): Promise<void> {
  const operation = enqueueWrite(async () => {
    const database = await openDatabase();
    try {
      await deleteFromDatabase(database);
    } finally {
      database.close();
    }
  });
  localRevisionTail = operation.then(() => observedRevision, () => observedRevision);
  return operation;
}

function deleteFromDatabase(database: IDBDatabase): Promise<void> {
  const transaction = database.transaction([storeName, metadataStoreName], "readwrite");
  transaction.objectStore(storeName).delete(draftKey);
  const metadataStore = transaction.objectStore(metadataStoreName);
  let nextGeneration = observedGeneration + 1;
  let nextRevision = observedRevision + 1;
  const generationRequest = metadataStore.get(generationKey);
  generationRequest.onsuccess = () => {
    const currentGeneration = Number.isSafeInteger(generationRequest.result) ? generationRequest.result as number : 0;
    nextGeneration = currentGeneration + 1;
    metadataStore.put(nextGeneration, generationKey);
    const revisionRequest = metadataStore.get(revisionKey);
    revisionRequest.onsuccess = () => {
      const currentRevision = Number.isSafeInteger(revisionRequest.result) ? revisionRequest.result as number : 0;
      nextRevision = currentRevision + 1;
      metadataStore.put(nextRevision, revisionKey);
    };
  };
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      observedGeneration = nextGeneration;
      observedRevision = nextRevision;
      localRevisionTail = Promise.resolve(nextRevision);
      draftChannel?.postMessage({ type: "cleared", generation: nextGeneration, revision: nextRevision });
      resolve();
    };
    transaction.onerror = () => reject(new Error("Could not clear the local draft."));
    transaction.onabort = () => reject(new Error("Could not clear the local draft."));
  });
}
