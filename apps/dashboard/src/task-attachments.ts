import { open, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { WorktreeManager } from "@deltapilot/core";
import type { TaskAttachment, TaskAttachmentCategory } from "@deltapilot/shared";

export const MAX_TASK_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_TASK_ATTACHMENT_UPLOAD_BYTES = 64 * 1024 * 1024;
export const TEXT_ATTACHMENT_PREVIEW_BYTES = 8 * 1024;

export interface AttachmentUpload {
  name: string;
  size: number;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface AttachmentTypeRule {
  category: TaskAttachmentCategory;
  mimeTypes: ReadonlySet<string>;
  mimePrefixes?: ReadonlyArray<string>;
  extensions: ReadonlySet<string>;
  defaultMimeType: string;
}

const ATTACHMENT_TYPE_RULES: ReadonlyArray<AttachmentTypeRule> = [
  {
    category: "image",
    mimeTypes: new Set([
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/bmp",
      "image/tiff",
      "image/heic",
      "image/heif",
      "image/avif",
    ]),
    extensions: new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".heif", ".avif"]),
    defaultMimeType: "image/png",
  },
  {
    category: "text",
    mimeTypes: new Set([
      "text/plain",
      "text/markdown",
      "text/csv",
      "text/tab-separated-values",
      "application/json",
      "application/xml",
      "text/xml",
      "application/x-yaml",
      "text/yaml",
    ]),
    extensions: new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".xml", ".yaml", ".yml", ".log"]),
    defaultMimeType: "text/plain",
  },
  {
    category: "document",
    mimeTypes: new Set([
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/rtf",
      "text/rtf",
      "application/vnd.oasis.opendocument.text",
    ]),
    extensions: new Set([".doc", ".docx", ".rtf", ".odt"]),
    defaultMimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  {
    category: "pdf",
    mimeTypes: new Set(["application/pdf"]),
    extensions: new Set([".pdf"]),
    defaultMimeType: "application/pdf",
  },
  {
    category: "video",
    mimeTypes: new Set([
      "video/mp4",
      "video/webm",
      "video/quicktime",
      "video/x-msvideo",
      "video/x-matroska",
      "video/mpeg",
    ]),
    mimePrefixes: ["video/"],
    extensions: new Set([".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv", ".mpeg", ".mpg"]),
    defaultMimeType: "video/mp4",
  },
  {
    category: "audio",
    mimeTypes: new Set([
      "audio/mpeg",
      "audio/wav",
      "audio/x-wav",
      "audio/mp4",
      "audio/aac",
      "audio/ogg",
      "audio/flac",
      "audio/webm",
    ]),
    mimePrefixes: ["audio/"],
    extensions: new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"]),
    defaultMimeType: "audio/mpeg",
  },
];

export interface TextAttachmentPreview {
  previewText: string | null;
  truncated: boolean;
}

export function sanitizeStoredAttachmentName(originalName: string): string {
  const normalized = path.basename(originalName).normalize("NFKC").replaceAll("\0", "");
  const ext = path.extname(normalized).toLowerCase().replace(/[^a-z0-9.]/g, "").slice(0, 16);
  const stem = path
    .basename(normalized, path.extname(normalized))
    .replace(/[^a-zA-Z0-9._ -]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^\.+/, "")
    .slice(0, 80);

  return `${stem || "attachment"}${ext}`;
}

export function classifyTaskAttachment(
  originalName: string,
  mimeType: string,
): { category: TaskAttachmentCategory; mimeType: string } | null {
  const normalizedMimeType = mimeType.trim().toLowerCase();
  const extension = path.extname(originalName).toLowerCase();

  for (const rule of ATTACHMENT_TYPE_RULES) {
    if (normalizedMimeType && rule.mimeTypes.has(normalizedMimeType)) {
      return { category: rule.category, mimeType: normalizedMimeType };
    }
    if (normalizedMimeType && rule.mimePrefixes?.some((prefix) => normalizedMimeType.startsWith(prefix))) {
      return { category: rule.category, mimeType: normalizedMimeType };
    }
  }

  for (const rule of ATTACHMENT_TYPE_RULES) {
    if (extension && rule.extensions.has(extension)) {
      return { category: rule.category, mimeType: mimeType.trim() || rule.defaultMimeType };
    }
  }

  return null;
}

export async function persistTaskAttachments(args: {
  files: AttachmentUpload[];
  taskId: string;
  now?: Date;
  uuid?: () => string;
  worktreeMgr: WorktreeManager;
}): Promise<TaskAttachment[]> {
  const ts = (args.now ?? new Date()).toISOString();
  await args.worktreeMgr.ensureAttachmentAccess(args.taskId);
  const attachmentDir = args.worktreeMgr.attachmentDir(args.taskId);

  const createdFiles: string[] = [];
  try {
    const attachments: TaskAttachment[] = [];
    for (const file of args.files) {
      if (!file.name.trim()) {
        throw new Error("every uploaded file must include a filename");
      }

      if (file.size > MAX_TASK_ATTACHMENT_BYTES) {
        throw new Error(
          `attachment "${file.name}" exceeds the ${formatAttachmentSize(MAX_TASK_ATTACHMENT_BYTES)} limit`,
        );
      }

      const classified = classifyTaskAttachment(file.name, file.type);
      if (!classified) {
        throw new Error(
          `attachment "${file.name}" is not a supported image, text, document, PDF, video, or audio file`,
        );
      }

      const attachmentId = args.uuid ? args.uuid() : crypto.randomUUID();
      const storedPath = path.join(
        attachmentDir,
        `${attachmentId}-${sanitizeStoredAttachmentName(file.name)}`,
      );
      const content = Buffer.from(await file.arrayBuffer());
      await writeFile(storedPath, content);
      createdFiles.push(storedPath);

      attachments.push({
        id: attachmentId,
        task_id: args.taskId,
        original_name: file.name,
        stored_path: storedPath,
        mime_type: classified.mimeType,
        size_bytes: content.byteLength,
        category: classified.category,
        created_at: ts,
      });
    }

    return attachments;
  } catch (error) {
    await Promise.all(createdFiles.map((filePath) => rm(filePath, { force: true })));
    throw error;
  }
}

export async function readTextAttachmentPreview(filePath: string): Promise<TextAttachmentPreview> {
  const handle = await open(filePath, "r");
  const buffer = Buffer.alloc(TEXT_ATTACHMENT_PREVIEW_BYTES + 1);

  try {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead === 0) {
      return { previewText: "", truncated: false };
    }

    const truncated = bytesRead > TEXT_ATTACHMENT_PREVIEW_BYTES;
    const previewBuffer = buffer.subarray(0, Math.min(bytesRead, TEXT_ATTACHMENT_PREVIEW_BYTES));
    return {
      previewText: previewBuffer.toString("utf8"),
      truncated,
    };
  } finally {
    await handle.close();
  }
}

export function makeContentDisposition(
  originalName: string,
  mode: "inline" | "attachment",
): string {
  const fallback = sanitizeStoredAttachmentName(originalName).replaceAll('"', "");
  const encoded = encodeURIComponent(originalName).replaceAll("'", "%27");
  return `${mode}; filename="${fallback || "attachment"}"; filename*=UTF-8''${encoded}`;
}

function formatAttachmentSize(sizeBytes: number): string {
  if (sizeBytes < 1024 * 1024) {
    return `${Math.ceil(sizeBytes / 1024)} KB`;
  }

  return `${(sizeBytes / (1024 * 1024)).toFixed(0)} MB`;
}
