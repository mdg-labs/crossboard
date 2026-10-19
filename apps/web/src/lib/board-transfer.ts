import { api } from "@/lib/api";
import type { Board } from "@/lib/boards";
import { failure } from "@/lib/views";

/** A file name made of the board's name, safe on common file systems. */
export function exportFileName(name: string): string {
  const stem = name
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^[-.]+|-+$/g, "")
    .slice(0, 60);
  return `${stem === "" ? "board" : stem}.crossboard.json`;
}

/** Downloads the board as a JSON file (SPEC FR-36). */
export async function downloadBoard(
  board: Pick<Board, "id" | "name">,
): Promise<void> {
  const response = await api.api.boards[":id"].export.$get({
    param: { id: String(board.id) },
  });
  if (!response.ok) {
    throw await failure(response);
  }
  const url = URL.createObjectURL(await response.blob());
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFileName(board.name);
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    // Some browsers start the download after click() returns and fail it
    // when the URL is already revoked, so the revoke waits for the next task.
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 0);
  }
}

/** Sends a board file to the server, which creates a new board from it (FR-36). */
export async function importBoard(file: File): Promise<Board> {
  const response = await api.api.boards.import.$post(undefined, {
    init: { body: await file.text() },
  });
  if (!response.ok) {
    throw await failure(response);
  }
  return (await response.json()) as Board;
}
