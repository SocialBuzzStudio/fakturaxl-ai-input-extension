// ==UserScript==
// @name         FXL AI - FakturaXL OCR
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Automatyczne wypełnianie faktur kosztowych w FakturaXL przy użyciu AI
// @author       SocialBuzzStudio Sp. z o.o. (socialbuzzstudio.com)
// @match        https://*.fakturaxl.pl/?page=faktura_vat_koszty*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // ============================================================================
    // SEKCJA 1: KONFIGURACJA I STAŁE
    // ============================================================================

    const CONFIG = {
        DEFAULT_MODEL: 'google/gemini-3-flash-preview',
        OPENROUTER_URL: 'https://openrouter.ai/api/v1/chat/completions'
    };

    // JSON Schema dla Structured Outputs (Single Source of Truth)
    const INVOICE_JSON_SCHEMA = {
        type: "object",
        properties: {
            numer: { type: "string", description: "Numer faktury" },
            data_wystawienia: { type: "string", description: "Format YYYY-MM-DD" },
            data_sprzedazy: { type: "string", description: "Format YYYY-MM-DD" },
            miejsce: { type: "string", description: "Miejsce wystawienia" },
            waluta: { type: "string", description: "Kod ISO waluty, np. PLN, EUR" },
            termin_platnosci_dni: { type: "string", description: "Liczba dni lub data płatności przekonwertowana na dni" },
            sprzedawca: {
                type: "object",
                properties: {
                    nazwa: { type: "string" },
                    nip: { type: "string", description: "Tylko cyfry, bez kresek" },
                    ulica: { type: "string" },
                    kod: { type: "string" },
                    miejscowosc: { type: "string" },
                    kraj: { type: "string" },
                    konto: { type: "string" }
                },
                required: ["nazwa", "nip", "ulica", "kod", "miejscowosc", "kraj", "konto"],
                additionalProperties: false
            },
            pozycje: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        nazwa: { type: "string" },
                        ilosc: { type: "number" },
                        jm: { type: "string", description: "Jednostka miary np. szt., kg, usł." },
                        cena_jednostkowa_na_fakturze: { 
                            type: "boolean", 
                            description: "Set to true ONLY if the unit price is explicitly printed on the document line. Set to false if only Total Net Value is visible." 
                        },
                        cena_jednostkowa_netto: { type: "number", description: "Cena za jedną jednostkę" },
                        wartosc_linii_netto: { type: "number", description: "Wartość netto pozycji (cena * ilość)" },
                        vat: { type: "string", description: "Stawka VAT jako liczba w stringu, np. '23'" }
                    },
                    required: ["nazwa", "ilosc", "jm", "cena_jednostkowa_na_fakturze", "cena_jednostkowa_netto", "wartosc_linii_netto", "vat"],
                    additionalProperties: false
                }
            }
        },
        required: [
            "numer", "data_wystawienia", "data_sprzedazy", "miejsce", 
            "waluta", "termin_platnosci_dni", "sprzedawca", "pozycje"
        ],
        additionalProperties: false
    };

    const SYSTEM_PROMPT = `Jesteś asystentem OCR specjalizującym się w polskich fakturach B2B. 
Przeanalizuj dostarczony obraz/PDF faktury i wyekstrahuj dane.

ZASADY LOGICZNE:
1. Daty zawsze w formacie YYYY-MM-DD.
2. NIP oczyść z kresek i spacji (same cyfry).
3. Rozróżniaj "Sprzedawcę" (Dostawcę) od Nabywcy.
4. Waluta jako kod ISO (PLN, EUR).

ZASADY DLA POZYCJI (KRYTYCZNE):
1. Jeśli na fakturze w linii widnieje cena za sztukę (Unit Price) -> ustaw "cena_jednostkowa_na_fakturze": true oraz przepisz tę wartość do "cena_jednostkowa_netto".
2. Jeśli na fakturze jest TYLKO wartość całkowita (Total) i Ilość (Quantity), a brak ceny jednostkowej -> ustaw "cena_jednostkowa_na_fakturze": false. W takim przypadku WYLICZ "cena_jednostkowa_netto" = "wartosc_linii_netto" / "ilosc".
3. "wartosc_linii_netto" to łączna wartość netto pozycji (zawsze przepisuj z faktury).

Wygeneruj odpowiedź ściśle według podanego schematu JSON.`;

    // ============================================================================
    // SEKCJA 2: MAPY DANYCH (Currency/Country Mapping)
    // ============================================================================

    const CURRENCY_MAP = {
        'PLN': '1', 'EUR': '10', 'USD': '4', 'GBP': '13',
        'CZK': '16', 'NOK': '19', 'SEK': '20', 'CHF': '12'
    };

    const COUNTRY_MAP = {
        'POLSKA': '1', 'NIEMCY': '3', 'CZECHY': '2', 
        'WIELKA BRYTANIA': '17', 'USA': '10', 'STANY ZJEDNOCZONE': '10',
        'FRANCJA': '40', 'HISZPANIA': '5', 'WŁOCHY': '16', 
        'UKRAINA': '14', 'HOLANDIA': '43', 'BELGIA': '23',
        'CHINY': '29'
    };

    // ============================================================================
    // SEKCJA 3: STYLE CSS (Modal UI) - Modern SaaS Design
    // ============================================================================

    GM_addStyle(`
        /* --- CORE VARIABLES & RESET --- */
        :root {
            --fxl-primary: #4f46e5;
            --fxl-primary-hover: #4338ca;
            --fxl-bg: #ffffff;
            --fxl-text-main: #111827;
            --fxl-text-muted: #6b7280;
            --fxl-border: #e5e7eb;
            --fxl-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1);
            --fxl-radius: 12px;
            --fxl-font: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        }

        /* --- MODAL OVERLAY --- */
        #fxl-ai-modal-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(17, 24, 39, 0.7);
            backdrop-filter: blur(4px);
            z-index: 9998;
            display: none;
            opacity: 0;
            transition: opacity 0.2s ease-in-out;
        }
        #fxl-ai-modal-overlay.visible {
            opacity: 1;
        }

        /* --- MODAL CONTAINER --- */
        #fxl-ai-modal {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -48%) scale(0.95);
            background: var(--fxl-bg);
            border-radius: var(--fxl-radius);
            box-shadow: var(--fxl-shadow);
            z-index: 9999;
            width: 480px;
            max-width: 92vw;
            max-height: 85vh;
            overflow-y: auto;
            display: none;
            opacity: 0;
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            font-family: var(--fxl-font);
            color: var(--fxl-text-main);
            border: 1px solid rgba(255,255,255,0.1);
        }
        #fxl-ai-modal.visible {
            transform: translate(-50%, -50%) scale(1);
            opacity: 1;
        }

        /* --- HEADER --- */
        #fxl-ai-modal-header {
            padding: 24px 24px 16px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid transparent;
        }

        #fxl-ai-modal-title {
            font-size: 20px;
            font-weight: 700;
            color: var(--fxl-text-main);
            margin: 0;
            display: flex;
            align-items: center;
            gap: 8px;
            letter-spacing: -0.025em;
        }
        
        #fxl-ai-modal-title span.icon {
            background: linear-gradient(135deg, #4f46e5 0%, #9333ea 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }

        #fxl-ai-modal-close {
            background: transparent;
            border: none;
            color: var(--fxl-text-muted);
            cursor: pointer;
            padding: 8px;
            border-radius: 8px;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        #fxl-ai-modal-close:hover {
            background: #f3f4f6;
            color: var(--fxl-text-main);
        }

        /* --- BODY --- */
        #fxl-ai-modal-body {
            padding: 0 24px 24px;
        }

        /* --- FORMS --- */
        .fxl-form-group {
            margin-bottom: 20px;
        }

        .fxl-form-group label {
            display: block;
            margin-bottom: 6px;
            font-size: 13px;
            font-weight: 500;
            color: var(--fxl-text-main);
        }

        .fxl-input-wrapper {
            position: relative;
        }

        .fxl-form-group input[type="password"],
        .fxl-form-group input[type="text"] {
            width: 100%;
            padding: 10px 12px;
            border: 1px solid var(--fxl-border);
            border-radius: 8px;
            font-size: 14px;
            background: #fff;
            color: var(--fxl-text-main);
            transition: all 0.2s;
            box-sizing: border-box;
            box-shadow: 0 1px 2px rgba(0,0,0,0.05);
        }

        .fxl-form-group input:focus {
            outline: none;
            border-color: var(--fxl-primary);
            box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.1);
        }
        
        .fxl-helper-text {
            font-size: 11px;
            color: var(--fxl-text-muted);
            margin-top: 6px;
        }

        /* --- DROP ZONE --- */
        #fxl-drop-zone {
            border: 2px dashed var(--fxl-border);
            border-radius: 12px;
            padding: 32px 20px;
            text-align: center;
            cursor: pointer;
            transition: all 0.2s ease;
            background: #f9fafb;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 12px;
        }

        #fxl-drop-zone:hover,
        #fxl-drop-zone.drag-over {
            border-color: var(--fxl-primary);
            background: #eff6ff;
        }
        
        .fxl-upload-icon {
            width: 40px;
            height: 40px;
            color: #9ca3af;
            transition: color 0.2s;
        }
        
        #fxl-drop-zone:hover .fxl-upload-icon {
            color: var(--fxl-primary);
        }

        #fxl-drop-zone p {
            margin: 0;
            font-size: 14px;
            font-weight: 500;
            color: var(--fxl-text-muted);
        }
        
        #fxl-drop-zone span.sub-text {
            font-size: 12px;
            color: #9ca3af;
        }

        #fxl-file-input {
            display: none;
        }

        /* --- FILE PREVIEW --- */
        #fxl-file-preview {
            display: none;
            padding: 12px;
            background: #f3f4f6;
            border-radius: 8px;
            margin-top: 12px;
            border: 1px solid #e5e7eb;
            align-items: center;
            gap: 10px;
        }
        
        .fxl-file-icon {
            width: 24px;
            height: 24px;
            color: var(--fxl-text-muted);
        }

        #fxl-file-preview p {
            margin: 0;
            font-size: 13px;
            font-weight: 500;
            color: var(--fxl-text-main);
            flex-grow: 1;
        }
        
        .fxl-remove-file {
            font-size: 18px;
            cursor: pointer;
            color: #9ca3af;
        }
        .fxl-remove-file:hover { color: #ef4444; }

        /* --- STATUS BAR --- */
        #fxl-status-bar {
            display: none;
            padding: 12px 16px;
            border-radius: 8px;
            margin-top: 16px;
            margin-bottom: 16px;
            font-size: 13px;
            font-weight: 500;
            animation: fadeIn 0.3s ease;
        }

        #fxl-status-bar.info {
            background: #eff6ff;
            color: #1e40af;
            border: 1px solid #dbeafe;
        }

        #fxl-status-bar.error {
            background: #fef2f2;
            color: #991b1b;
            border: 1px solid #fee2e2;
        }

        #fxl-status-bar.success {
            background: #ecfdf5;
            color: #065f46;
            border: 1px solid #d1fae5;
        }

        #fxl-status-text { margin: 0; }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(-5px); }
            to { opacity: 1; transform: translateY(0); }
        }

        /* --- PROCESS BUTTON --- */
        #fxl-process-btn {
            width: 100%;
            padding: 12px;
            background: linear-gradient(135deg, var(--fxl-primary) 0%, #7c3aed 100%);
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            box-shadow: 0 4px 6px -1px rgba(79, 70, 229, 0.2);
            position: relative;
            overflow: hidden;
            letter-spacing: 0.01em;
        }

        #fxl-process-btn:hover:not(:disabled) {
            transform: translateY(-1px);
            box-shadow: 0 6px 8px -1px rgba(79, 70, 229, 0.3);
        }
        
        #fxl-process-btn:active:not(:disabled) {
            transform: translateY(0);
        }

        #fxl-process-btn:disabled {
            background: #e5e7eb;
            color: #9ca3af;
            cursor: not-allowed;
            box-shadow: none;
        }

        /* Loading Spinner inside Button */
        #fxl-process-btn.loading {
            color: transparent;
        }
        
        #fxl-process-btn.loading::after {
            content: "";
            position: absolute;
            width: 18px;
            height: 18px;
            top: 50%;
            left: 50%;
            margin-left: -9px;
            margin-top: -9px;
            border: 2px solid rgba(255,255,255,0.3);
            border-top: 2px solid white;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        /* --- TRIGGER BUTTON (FAB) --- */
        #fxl-ai-trigger-btn {
            position: fixed;
            bottom: 30px;
            right: 30px;
            padding: 0;
            width: 56px;
            height: 56px;
            border-radius: 28px;
            background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
            color: white;
            border: none;
            cursor: pointer;
            box-shadow: 0 10px 15px -3px rgba(79, 70, 229, 0.3), 0 4px 6px -2px rgba(79, 70, 229, 0.1);
            transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            z-index: 9997;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        #fxl-ai-trigger-btn svg {
            width: 28px;
            height: 28px;
            fill: none;
            stroke: currentColor;
            stroke-width: 2;
            stroke-linecap: round;
            stroke-linejoin: round;
        }

        #fxl-ai-trigger-btn:hover {
            transform: translateY(-4px) scale(1.05);
            box-shadow: 0 20px 25px -5px rgba(79, 70, 229, 0.4);
        }
        
        /* Tooltip for FAB */
        #fxl-ai-trigger-btn::before {
            content: "Wypełnij z AI";
            position: absolute;
            right: 70px;
            background: #1f2937;
            color: white;
            padding: 6px 12px;
            border-radius: 6px;
            font-size: 12px;
            font-weight: 500;
            opacity: 0;
            transform: translateX(10px);
            transition: all 0.2s;
            pointer-events: none;
            white-space: nowrap;
        }
        
        #fxl-ai-trigger-btn:hover::before {
            opacity: 1;
            transform: translateX(0);
        }
    `);

    // ============================================================================
    // SEKCJA 4: KLASA ConfigManager (Storage Management)
    // ============================================================================

    class ConfigManager {
        static getApiKey() {
            return GM_getValue('fxl_ai_apiKey', '');
        }

        static setApiKey(key) {
            GM_setValue('fxl_ai_apiKey', key);
        }

        static getModel() {
            return GM_getValue('fxl_ai_model', CONFIG.DEFAULT_MODEL);
        }

        static setModel(model) {
            GM_setValue('fxl_ai_model', model);
        }
    }

    // ============================================================================
    // SEKCJA 5: KLASA APIService (OpenRouter Communication)
    // ============================================================================

    class APIService {
        static async analyzeInvoice(fileBase64, mimeType, apiKey, model) {
            return new Promise((resolve, reject) => {
                const isPDF = mimeType === 'application/pdf' || mimeType.includes('pdf');
                let payload;

                if (isPDF) {
                    const dataUrl = `data:application/pdf;base64,${fileBase64}`;
                    payload = {
                        model: model,
                        messages: [
                            {
                                role: 'user',
                                content: [
                                    { type: 'text', text: SYSTEM_PROMPT },
                                    {
                                        type: 'file',
                                        file: {
                                            filename: 'invoice.pdf',
                                            file_data: dataUrl
                                        }
                                    }
                                ]
                            }
                        ],
                        plugins: [
                            {
                                id: 'file-parser',
                                pdf: { engine: 'pdf-text' }
                            }
                        ],
                        response_format: {
                            type: "json_schema",
                            json_schema: {
                                name: "invoice_extraction",
                                strict: true,
                                schema: INVOICE_JSON_SCHEMA
                            }
                        }
                    };
                } else {
                    const dataUrl = `data:${mimeType};base64,${fileBase64}`;
                    payload = {
                        model: model,
                        messages: [
                            {
                                role: 'user',
                                content: [
                                    { type: 'text', text: SYSTEM_PROMPT },
                                    {
                                        type: 'image_url',
                                        image_url: { url: dataUrl }
                                    }
                                ]
                            }
                        ],
                        response_format: {
                            type: "json_schema",
                            json_schema: {
                                name: "invoice_extraction",
                                strict: true,
                                schema: INVOICE_JSON_SCHEMA
                            }
                        }
                    };
                }

                console.log("%c🚀 [FXL AI] Payload wysyłany do AI:", "color: blue; font-weight: bold;", JSON.stringify(payload, null, 2));

                GM_xmlhttpRequest({
                    method: 'POST',
                    url: CONFIG.OPENROUTER_URL,
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`,
                        'HTTP-Referer': 'https://fakturaxl.pl',
                        'X-Title': 'FXL AI OCR Extension'
                    },
                    data: JSON.stringify(payload),
                    onload: function(response) {
                        console.log("%c📥 [FXL AI] Surowa odpowiedź z AI:", "color: green; font-weight: bold;", response.responseText);

                        if (response.status !== 200) {
                            try {
                                const errorData = JSON.parse(response.responseText);
                                reject(new Error(`API Error: ${errorData.error?.message || response.statusText}`));
                            } catch (e) {
                                reject(new Error(`API Error (${response.status}): ${response.responseText.substring(0, 100)}`));
                            }
                            return;
                        }

                        try {
                            const data = JSON.parse(response.responseText);
                            
                            if (!data.choices || !data.choices[0] || !data.choices[0].message) {
                                reject(new Error('Otrzymano nieprawidłową odpowiedź z serwera AI.'));
                                return;
                            }

                            const content = data.choices[0].message.content;
                            let invoiceData;
                            try {
                                invoiceData = JSON.parse(content);
                            } catch (e) {
                                console.error("JSON Parse Error. Content received:", content);
                                reject(new Error('AI zwróciło dane w niepoprawnym formacie.'));
                                return;
                            }

                            if (!invoiceData.numer) {
                                reject(new Error('Nie udało się odczytać numeru faktury.'));
                                return;
                            }

                            console.log('✅ [FXL AI] Sparsowane dane faktury:', invoiceData);
                            resolve(invoiceData);

                        } catch (error) {
                            reject(new Error(`Błąd przetwarzania odpowiedzi: ${error.message}`));
                        }
                    },
                    onerror: function(error) {
                        console.error('❌ [FXL AI] Błąd połączenia z API:', error);
                        reject(new Error('Błąd połączenia z OpenRouter API.'));
                    }
                });
            });
        }
    }

    // ============================================================================
    // SEKCJA 6: KLASA FormFiller (Core Business Logic)
    // ============================================================================

    class FormFiller {
        static async fill(invoiceData) {
            console.log('FXL AI: Rozpoczynam wypełnianie formularza...');

            // === FUNKCJE POMOCNICZE ===
            const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

            const setVal = (selector, value) => {
                const $el = $(selector);
                if ($el.length) {
                    $el.val(value);
                    $el.trigger('change').trigger('input').trigger('blur').trigger('keyup');
                    if($el.parent().hasClass('date')) {
                        $el.parent().datepicker('update', value);
                    }
                } else {
                    console.warn(`Nie znaleziono pola: ${selector}`);
                }
            };
            
            const forceSetVal = (selector, value) => {
                const $el = $(selector);
                if ($el.length && $el.is(':visible')) {
                    $el.prop('readonly', false).prop('disabled', false).removeClass('disabled').removeClass('readonly');
                    $el.val(value);
                    $el.trigger('change').trigger('input').trigger('blur').trigger('keyup').trigger('focusout');
                    return true;
                }
                return false;
            };

            const getMapValue = (valueFromAI, map, defaultValue) => {
                if (!valueFromAI) return defaultValue;
                const normalizedValue = valueFromAI.toString().toUpperCase().trim();
                return map[normalizedValue] || defaultValue;
            };

            try {
                // 1. DANE NAGŁÓWKOWE
                setVal('#numer_faktury', invoiceData.numer || '');
                setVal('#data_wystawienia', invoiceData.data_wystawienia || '');
                setVal('#miejsce', invoiceData.miejsce || '');
                setVal('#data_sprzedazy', invoiceData.data_sprzedazy || '');

                // 1a. WALUTA
                const currencyId = getMapValue(invoiceData.waluta, CURRENCY_MAP, '1');
                setVal('#waluta', currencyId);
                const isPLN = currencyId === '1';
                console.log(`FXL AI: Ustawiono walutę: ${invoiceData.waluta || 'PLN'} (ID: ${currencyId}).`);

                // 2. DANE SPRZEDAWCY
                if (invoiceData.sprzedawca) {
                    if($('#nabywca_more').is(':visible') && !$('#nr_konta_bankowego_n').is(':visible')) {
                        $('#nabywca_more').click();
                        await sleep(200);
                    }

                    setVal('#nazwa_n', invoiceData.sprzedawca.nazwa || '');
                    setVal('#nip_n', invoiceData.sprzedawca.nip || '');
                    setVal('#ulica_i_numer_n', invoiceData.sprzedawca.ulica || '');
                    setVal('#kod_pocztowy_n', invoiceData.sprzedawca.kod || '');
                    setVal('#miejscowosc_n', invoiceData.sprzedawca.miejscowosc || '');
                    setVal('#nr_konta_bankowego_n', invoiceData.sprzedawca.konto || '');

                    const countryId = getMapValue(invoiceData.sprzedawca.kraj, COUNTRY_MAP, '1');
                    setVal('#kraj_id_n', countryId);
                    console.log(`FXL AI: Ustawiono kraj: ${invoiceData.sprzedawca.kraj || 'Polska'} (ID: ${countryId})`);
                }

                // 3. POZYCJE NA FAKTURZE
                if (invoiceData.pozycje && invoiceData.pozycje.length > 0) {
                    const addButton = $('#dodaj_pozycje_zamowienia_plus');

                    for (let i = 0; i < invoiceData.pozycje.length; i++) {
                        const rowIndex = i + 1;
                        const item = invoiceData.pozycje[i];

                        let rowExists = $(`#nazwa_${rowIndex}`).length > 0;

                        if (!rowExists && i > 0) {
                            addButton.click();
                            await sleep(300);
                        }

                        // 3a. WARTOŚCI TEKSTOWE
                        setVal(`#nazwa_${rowIndex}`, item.nazwa || '');
                        const quantity = parseFloat(item.ilosc) || 1;
                        setVal(`#ilosc_${rowIndex}`, quantity);
                        
                        // Jednostka miary
                        const unitFromAI = item.jm || 'szt.';
                        const $jmSelect = $(`#jm_${rowIndex}`);
                        if ($jmSelect.find(`option[value="${unitFromAI}"]`).length > 0) {
                            setVal(`#jm_${rowIndex}`, unitFromAI);
                        } else {
                            setVal(`#jm_${rowIndex}`, 'inna');
                            await sleep(100);
                            setVal(`#jm_${rowIndex}`, unitFromAI);
                        }

                        setVal(`#vat_${rowIndex}`, item.vat || '23');
                        
                        // 3b. STRATEGIA WARTOŚCI (Kluczowa zmiana: Poprawione Selektory)
                        let valueSet = false;
                        
                        if (isPLN) {
                            // STRATEGIA 1: Wpisanie Wartości Netto (Total Net)
                            const totalNetValue = parseFloat(item.wartosc_linii_netto).toFixed(2);
                            const netSelectors = [
                                `#wartosc_netto_rabat_${rowIndex}`,
                                `#wartosc_netto_${rowIndex}`,
                                `input[name="faktura_pozycje[${rowIndex}][wartosc_netto_rabat]"]`
                            ];
                            
                            for (const sel of netSelectors) {
                                if (forceSetVal(sel, totalNetValue)) {
                                    console.log(`FXL AI: [PLN] Sukces! Wpisano wartość netto: ${totalNetValue} do ${sel}`);
                                    valueSet = true;
                                    break;
                                }
                            }
                            
                            // STRATEGIA 2: Wpisanie Wartości Brutto (Jeśli Netto zawiodło)
                            if (!valueSet) {
                                console.log(`FXL AI: [PLN] Nie udało się wpisać Netto. Próbuję Brutto...`);
                                const vatRate = parseFloat(item.vat) || 23;
                                const totalGrossValue = (parseFloat(item.wartosc_linii_netto) * (1 + vatRate / 100)).toFixed(2);
                                
                                const grossSelectors = [
                                    `#wartosc_brutto_rabat_${rowIndex}`,
                                    `#wartosc_brutto_${rowIndex}`,
                                    `input[name="faktura_pozycje[${rowIndex}][wartosc_brutto_rabat]"]`
                                ];
                                
                                for (const sel of grossSelectors) {
                                    if (forceSetVal(sel, totalGrossValue)) {
                                        console.log(`FXL AI: [PLN] Sukces! Wpisano wartość BRUTTO: ${totalGrossValue} do ${sel}`);
                                        valueSet = true;
                                        break;
                                    }
                                }
                            }
                        }
                        
                        // STRATEGIA 3 (FALLBACK): Jeśli wszystko inne zawiodło, wpisujemy cenę jednostkową
                        if (!valueSet) {
                            console.warn(`FXL AI: [FALLBACK] Nie udało się wpisać sumy. Wpisuję cenę jednostkową.`);
                            
                            let unitPrice;
                            if (item.cena_jednostkowa_na_fakturze) {
                                unitPrice = parseFloat(item.cena_jednostkowa_netto);
                            } else {
                                unitPrice = parseFloat(item.wartosc_linii_netto) / quantity;
                            }
                            
                            setVal(`#netto_${rowIndex}`, unitPrice.toFixed(4));
                        }
                    }
                }

                // 4. TERMIN PŁATNOŚCI
                setVal('#termin_platnosci_dni', invoiceData.termin_platnosci_dni || '14');

                // 5. Przeliczenie sum
                if (typeof window.oblicz_sumy === "function") {
                    window.oblicz_sumy();
                }

                console.log('FXL AI: Zakończono wypełnianie formularza.');
            } catch (error) {
                console.error('FXL AI: Błąd podczas wypełniania formularza:', error);
                throw error;
            }
        }
    }

    // ============================================================================
    // SEKCJA 7: KLASA FileUploader (Dropzone Integration)
    // ============================================================================

    class FileUploader {
        static upload(file) {
            console.log(`FXL AI: Załączam plik ${file.name}...`);

            const triggerInputFallback = (fileObj) => {
                const hiddenInput = document.querySelector('input.dz-hidden-input') || document.querySelector('input[type=file]');
                if (hiddenInput) {
                    const dataTransfer = new DataTransfer();
                    dataTransfer.items.add(fileObj);
                    hiddenInput.files = dataTransfer.files;
                    hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
                    console.log('FXL AI: Plik dodany przez input fallback (Safety).');
                } else {
                    console.error('FXL AI: Nie znaleziono żadnego mechanizmu uploadu.');
                }
            };

            if (typeof window.Dropzone !== 'undefined' && window.Dropzone.instances.length > 0) {
                try {
                    const myDropzone = window.Dropzone.instances[0];
                    console.log(`FXL AI: Próba dodania pliku do Dropzone API...`);
                    myDropzone.addFile(file);
                    console.log('FXL AI: Wywołano Dropzone.addFile (sprawdź czy plik jest na liście).');
                } catch (dzError) {
                    console.warn('FXL AI: Dropzone API Error (ignoruję i próbuję fallback):', dzError);
                    triggerInputFallback(file); 
                }
            } else {
                triggerInputFallback(file);
            }
        }
    }

    // ============================================================================
    // SEKCJA 8: KLASA UIManager (Interface Management)
    // ============================================================================

    class UIManager {
        constructor() {
            this.elements = {};
            this.currentFile = null;
        }

        init() {
            this.injectTriggerButton();
            this.createModal();
            this.attachEventListeners();
            
            // Rejestracja komendy menu (opcjonalnie)
            GM_registerMenuCommand("Otwórz FXL AI", () => this.openModal());
        }

        injectTriggerButton() {
            const btn = document.createElement('button');
            btn.id = 'fxl-ai-trigger-btn';
            // SVG Icon: Sparkles / Magic
            btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" /></svg>`;
            btn.onclick = () => this.openModal();
            document.body.appendChild(btn);
        }

        createModal() {
            // Icons SVG
            const icons = {
                close: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
                upload: `<svg class="fxl-upload-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>`,
                file: `<svg class="fxl-file-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>`,
                sparkles: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 6px;"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"></path></svg>`
            };

            // Overlay
            const overlay = document.createElement('div');
            overlay.id = 'fxl-ai-modal-overlay';
            overlay.onclick = (e) => {
                if (e.target === overlay) this.closeModal();
            };

            // Modal
            const modal = document.createElement('div');
            modal.id = 'fxl-ai-modal';
            modal.innerHTML = `
                <div id="fxl-ai-modal-header">
                    <h3 id="fxl-ai-modal-title">
                        <span class="icon">✨</span> FXL AI
                    </h3>
                    <button id="fxl-ai-modal-close" type="button">${icons.close}</button>
                </div>
                <div id="fxl-ai-modal-body">
                    <div class="fxl-form-group">
                        <label for="fxl-api-key">Klucz API OpenRouter</label>
                        <input type="password" id="fxl-api-key" placeholder="sk-or-v1-...">
                        <div class="fxl-helper-text">Klucz jest szyfrowany i zapisywany lokalnie w przeglądarce.</div>
                    </div>

                    <div class="fxl-form-group">
                        <label for="fxl-model">Model AI</label>
                        <input type="text" id="fxl-model" placeholder="google/gemini-3-flash-preview">
                    </div>

                    <div class="fxl-form-group">
                        <label>Plik faktury</label>
                        <div id="fxl-drop-zone">
                            ${icons.upload}
                            <div>
                                <p>Kliknij lub upuść plik tutaj</p>
                                <span class="sub-text">Obsługiwane: PDF, JPG, PNG</span>
                            </div>
                        </div>
                        <input type="file" id="fxl-file-input" accept=".pdf,.jpg,.jpeg,.png">
                        
                        <div id="fxl-file-preview" style="display:none;">
                            ${icons.file}
                            <p id="fxl-file-name">-</p>
                            <span class="fxl-remove-file" title="Usuń plik">&times;</span>
                        </div>
                    </div>

                    <div id="fxl-status-bar">
                        <p id="fxl-status-text">Oczekiwanie...</p>
                    </div>

                    <button id="fxl-process-btn" type="button" disabled>
                        ${icons.sparkles} Przetwórz fakturę z AI
                    </button>
                </div>
            `;

            document.body.appendChild(overlay);
            document.body.appendChild(modal);

            // Cache elementów
            this.elements = {
                overlay: overlay,
                modal: modal,
                closeBtn: modal.querySelector('#fxl-ai-modal-close'),
                apiKeyInput: modal.querySelector('#fxl-api-key'),
                modelInput: modal.querySelector('#fxl-model'),
                dropZone: modal.querySelector('#fxl-drop-zone'),
                fileInput: modal.querySelector('#fxl-file-input'),
                filePreview: modal.querySelector('#fxl-file-preview'),
                fileName: modal.querySelector('#fxl-file-name'),
                removeFileBtn: modal.querySelector('.fxl-remove-file'),
                statusBar: modal.querySelector('#fxl-status-bar'),
                statusText: modal.querySelector('#fxl-status-text'),
                processBtn: modal.querySelector('#fxl-process-btn')
            };
        }

        attachEventListeners() {
            // Zamknięcie modala
            this.elements.closeBtn.onclick = () => this.closeModal();

            // Usuwanie pliku
            if (this.elements.removeFileBtn) {
                this.elements.removeFileBtn.onclick = (e) => {
                    e.stopPropagation();
                    this.resetFile();
                };
            }

            // Dropzone clicks
            this.elements.dropZone.onclick = () => this.elements.fileInput.click();

            // File input change
            this.elements.fileInput.onchange = (e) => this.handleFileSelect(e.target.files[0]);

            // Drag & Drop
            this.elements.dropZone.ondragover = (e) => {
                e.preventDefault();
                this.elements.dropZone.classList.add('drag-over');
            };

            this.elements.dropZone.ondragleave = () => {
                this.elements.dropZone.classList.remove('drag-over');
            };

            this.elements.dropZone.ondrop = (e) => {
                e.preventDefault();
                this.elements.dropZone.classList.remove('drag-over');
                if (e.dataTransfer.files.length > 0) {
                    this.handleFileSelect(e.dataTransfer.files[0]);
                }
            };

            // Validacja inputów
            this.elements.apiKeyInput.oninput = () => this.validateForm();
            this.elements.modelInput.oninput = () => this.validateForm();

            // Przycisk przetwarzania
            this.elements.processBtn.onclick = () => this.handleProcess();
        }

        openModal() {
            // Załaduj zapisane wartości
            this.elements.apiKeyInput.value = ConfigManager.getApiKey();
            this.elements.modelInput.value = ConfigManager.getModel();
            
            this.elements.overlay.style.display = 'block';
            this.elements.modal.style.display = 'block';
            
            // Animacja wejścia (Next frame for transition)
            requestAnimationFrame(() => {
                this.elements.overlay.classList.add('visible');
                this.elements.modal.classList.add('visible');
            });

            this.validateForm();
        }

        closeModal() {
            // Animacja wyjścia
            this.elements.overlay.classList.remove('visible');
            this.elements.modal.classList.remove('visible');

            setTimeout(() => {
                this.elements.overlay.style.display = 'none';
                this.elements.modal.style.display = 'none';
                this.hideStatus();
            }, 300); // Match transition duration
        }

        handleFileSelect(file) {
            if (!file) return;

            const validTypes = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'];
            if (!validTypes.includes(file.type)) {
                this.showStatus('Nieprawidłowy format pliku. Wybierz PDF, JPG lub PNG.', 'error');
                return;
            }

            this.currentFile = file;
            const sizeMB = (file.size / 1024 / 1024).toFixed(2);
            this.elements.fileName.textContent = `${file.name} (${sizeMB} MB)`;
            
            this.elements.filePreview.style.display = 'flex';
            this.elements.dropZone.style.display = 'none';
            this.validateForm();
            this.hideStatus();
        }

        resetFile() {
            this.currentFile = null;
            this.elements.fileInput.value = '';
            this.elements.filePreview.style.display = 'none';
            this.elements.dropZone.style.display = 'flex';
            this.validateForm();
        }

        validateForm() {
            const apiKey = this.elements.apiKeyInput.value.trim();
            const model = this.elements.modelInput.value.trim();
            const isValid = apiKey.length > 0 && model.length > 0 && this.currentFile;
            this.elements.processBtn.disabled = !isValid;
        }

        async handleProcess() {
            const apiKey = this.elements.apiKeyInput.value.trim();
            const model = this.elements.modelInput.value.trim();

            if (!this.currentFile) {
                this.showStatus('Wybierz plik faktury.', 'error');
                return;
            }

            // Zapisz ustawienia
            ConfigManager.setApiKey(apiKey);
            ConfigManager.setModel(model);

            // UI - Loading state
            this.elements.processBtn.disabled = true;
            this.elements.processBtn.classList.add('loading');
            const originalBtnText = this.elements.processBtn.innerHTML;
            this.elements.processBtn.textContent = ''; // Hide text for spinner

            try {
                // 1. Konwertuj plik do Base64
                this.showStatus('Wysyłanie pliku...', 'info');
                const { base64, mimeType } = await this.fileToBase64(this.currentFile);

                // 2. Wyślij do OpenRouter
                this.showStatus('Analiza faktury przez AI...', 'info');
                const invoiceData = await APIService.analyzeInvoice(base64, mimeType, apiKey, model);

                // 3. Wypełnij formularz
                this.showStatus('Wypełnianie formularza...', 'info');
                await FormFiller.fill(invoiceData);

                // 4. Upload pliku do Dropzone
                this.showStatus('Załączanie pliku...', 'info');
                FileUploader.upload(this.currentFile);

                // Sukces
                this.showStatus('Gotowe! Faktura przetworzona.', 'success');

                // Zamknij modal po chwili
                setTimeout(() => {
                    this.closeModal();
                    this.resetForm();
                }, 2000);

            } catch (error) {
                console.error('❌ [FXL AI] Błąd przetwarzania:', error);
                this.showStatus(error.message || 'Wystąpił nieoczekiwany błąd.', 'error');
            } finally {
                this.elements.processBtn.disabled = false;
                this.elements.processBtn.classList.remove('loading');
                this.elements.processBtn.innerHTML = originalBtnText;
            }
        }

        fileToBase64(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                    const base64 = reader.result.split(',')[1];
                    resolve({ base64, mimeType: file.type });
                };
                reader.onerror = () => reject(new Error('Nie udało się odczytać pliku.'));
                reader.readAsDataURL(file);
            });
        }

        showStatus(message, type = 'info') {
            this.elements.statusText.textContent = message;
            this.elements.statusBar.style.display = 'block';
            this.elements.statusBar.className = ''; // Reset classes
            this.elements.statusBar.classList.add(type);
        }

        hideStatus() {
            this.elements.statusBar.style.display = 'none';
        }

        resetForm() {
            this.resetFile();
        }
    }

    // ============================================================================
    // SEKCJA 9: GŁÓWNA INICJALIZACJA (App Entry Point)
    // ============================================================================

    class App {
        static init() {
            console.log('🚀 [FXL AI] UserScript inicjalizowany...');
            
            // Sprawdź czy jesteśmy na właściwej stronie
            if (!window.location.href.match(/https:\/\/(?:[a-zA-Z0-9-]+\.)?fakturaxl\.pl\/\?page=faktura_vat_koszty/)) {
                console.warn('[FXL AI] Niewłaściwa strona - UserScript nie zostanie uruchomiony.');
                return;
            }

            // Inicjalizacja UI
            const ui = new UIManager();
            ui.init();
            
            console.log('✅ [FXL AI] UserScript gotowy do użycia!');
        }
    }

    // === URUCHOMIENIE ===
    // Użyj różnych strategii w zależności od stanu DOM
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => App.init());
    } else {
        // DOM już załadowany
        App.init();
    }

})();
