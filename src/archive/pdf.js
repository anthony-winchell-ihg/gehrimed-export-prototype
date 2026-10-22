// GEHRIMed's Download prompt says: "This password will be used to encrypt
// the PDF." So the download may be a password-protected PDF (rather than, or
// inside, a 7-Zip archive). These helpers detect and remove that password.
import fs from "node:fs/promises";
import muhammara from "muhammara";

/** True if the PDF has an encryption dictionary (i.e. it's password-protected). */
export const isEncryptedPdf = async (file) => {
  const bytes = await fs.readFile(file);
  return bytes.includes(Buffer.from("/Encrypt"));
};

/**
 * Writes an unencrypted copy of `input` to `output`, using `password`.
 * Throws (without echoing the password) if the password is wrong.
 */
export const decryptPdf = async (input, output, password) => {
  try {
    muhammara.recrypt(input, output, { password });
  } catch {
    throw new Error(
      "Could not remove the PDF password (wrong password or unsupported PDF)",
    );
  }
  if (await isEncryptedPdf(output)) {
    throw new Error("PDF is still encrypted after decryption");
  }
};

/** Test helper: writes a password-protected copy of `input` to `output`. */
export const encryptPdf = (input, output, password) =>
  muhammara.recrypt(input, output, {
    userPassword: password,
    ownerPassword: password,
    userProtectionFlag: 4,
  });

/** Test helper: writes a minimal one-page PDF. */
export const writeBlankPdf = (file) => {
  const writer = muhammara.createWriter(file);
  writer.writePage(writer.createPage(0, 0, 612, 792));
  writer.end();
};
