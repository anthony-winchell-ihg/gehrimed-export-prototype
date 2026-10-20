// One line per encounter: what happened to it.
//   • withFiles: true  → includes the PDF file names (which contain patient
//     names) — only for the copy that goes inside the zip, next to the PDFs.
//   • withFiles: false → encounter ID + status + error only, safe to share
//     with whoever troubleshoots.
import fs from "node:fs/promises";

export const createManifest = () => {
  const rows = [];
  return {
    ok: (encounterId, files) => rows.push({ encounterId, status: "ok", files: files.join(" "), error: "" }),
    failed: (encounterId, error) => rows.push({ encounterId, status: "failed", files: "", error }),
    summary: () => ({
      ok: rows.filter((r) => r.status === "ok").length,
      failed: rows.filter((r) => r.status === "failed").length,
    }),
    write: async (file, { withFiles = false } = {}) => {
      const escape = (v) => `"${String(v).replace(/"/g, '""')}"`;
      const header = withFiles ? "encounterId,status,files,error" : "encounterId,status,error";
      const lines = [
        header,
        ...rows.map((r) =>
          (withFiles ? [r.encounterId, r.status, r.files, r.error] : [r.encounterId, r.status, r.error])
            .map(escape)
            .join(","),
        ),
      ];
      await fs.writeFile(file, lines.join("\r\n") + "\r\n", "utf8");
    },
  };
};
