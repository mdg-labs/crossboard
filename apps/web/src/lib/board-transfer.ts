import { api } from "@/lib/api";
import type { Board } from "@/lib/boards";
import { ApiError } from "@/lib/views";

async function failure(response: Response): Promise<ApiError> {
  try {
    const body: unknown = await response.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "object" &&
      body.error !== null &&
      "message" in body.error &&
      typeof body.error.message === "string"
    ) {
      const code =
        "code" in body.error && typeof body.error.code === "string"
          ? body.error.code
          : null;
      return new ApiError(response.status, code, body.error.message);
    }
  } catch {
    // The body is not the API's error shape; fall back to the status.
  }
  return new ApiError(
    response.status,
    null,
    `The server answered ${response.status}.`,
  );
}

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
    URL.revokeObjectURL(url);
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
