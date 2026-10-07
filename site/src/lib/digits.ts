// 0-9 → Arabic-Indic digits (U+0660–U+0669), built from code points to keep the source ASCII.
export const toArabicDigits = (n: number) =>
  String(n).replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d)))
