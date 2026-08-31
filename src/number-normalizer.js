(() => {
  const selector = "input[name='salePrice'], input[name='creditLimit'], input[name='lowThreshold'], input[data-sales-num], input[data-po-field='qty'], input[data-po-field='price'], input[data-po-field='payment']";
  const arabicDigits = "٠١٢٣٤٥٦٧٨٩";
  const persianDigits = "۰۱۲۳۴۵۶۷۸۹";
  const normalizeNumber = (value, input) => {
    const allowDecimal = input?.name !== "lowThreshold";
    let text = String(value || "")
      .replace(/[٠-٩]/g, (digit) => String(arabicDigits.indexOf(digit)))
      .replace(/[۰-۹]/g, (digit) => String(persianDigits.indexOf(digit)))
      .replace(/[٫،]/g, ".")
      .replace(/\s+/g, "");

    const commaCount = (text.match(/,/g) || []).length;
    if (allowDecimal && !text.includes(".") && commaCount === 1) {
      const [, decimalPart = ""] = text.split(",");
      if (/^\d{1,2}$/.test(decimalPart)) text = text.replace(",", ".");
    }

    text = text.replace(/,/g, "").replace(/[^\d.]/g, "");
    if (!allowDecimal) return text.replace(/\./g, "");

    const parts = text.split(".");
    text = `${parts.shift() || ""}${parts.length ? `.${parts.join("")}` : ""}`;
    return text.startsWith(".") ? `0${text}` : text;
  };

  const prepareInputs = (root = document) => {
    root.querySelectorAll?.(selector).forEach((input) => {
      if (input.type !== "text") input.type = "text";
      input.inputMode = input.name === "lowThreshold" ? "numeric" : "decimal";
      input.dir = "ltr";
      const normalized = normalizeNumber(input.value, input);
      if (normalized !== input.value) input.value = normalized;
    });
  };

  document.addEventListener(
    "input",
    (event) => {
      if (!event.target?.matches?.(selector)) return;
      const input = event.target;
      const normalized = normalizeNumber(input.value, input);
      if (normalized !== input.value) input.value = normalized;
    },
    true
  );

  document.addEventListener("submit", () => prepareInputs(document), true);
  new MutationObserver(() => prepareInputs(document)).observe(document.documentElement, { childList: true, subtree: true });
  prepareInputs(document);
})();
