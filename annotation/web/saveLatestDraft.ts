/** Keep saving when edits arrive during a request; errors leave the latest draft pending. */
export async function saveLatestDraft(readPending: () => string | null, save: (value: string) => Promise<void>): Promise<void> {
  for (let value = readPending(); value !== null; value = readPending()) {
    await save(value);
  }
}
