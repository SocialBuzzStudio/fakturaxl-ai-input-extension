// === STAŁE I KONFIGURACJA ===
const VALID_URL_REGEX = /^https:\/\/(?:[a-zA-Z0-9-]+\.)?fakturaxl\.pl\/\?page=faktura_vat_koszty/;

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

// === ELEMENTY DOM ===
let elements = {};

// === INICJALIZACJA ===
document.addEventListener('DOMContentLoaded', async () => {
    // Cache elementów DOM
    elements = {
        form: document.getElementById('ocr-form'),
        apiKeyInput: document.getElementById('api-key'),
        modelInput: document.getElementById('model'),
        fileInput: document.getElementById('file-input'),
        dropZone: document.getElementById('drop-zone'),
        filePreview: document.getElementById('file-preview'),
        fileNameText: document.getElementById('file-name-text'),
        processBtn: document.getElementById('process-btn'),
        btnText: document.getElementById('btn-text'),
        btnLoader: document.getElementById('btn-loader'),
        errorContainer: document.getElementById('error-container'),
        errorText: document.getElementById('error-text'),
        statusContainer: document.getElementById('status-container'),
        statusText: document.getElementById('status-text')
    };

    // Załaduj zapisane ustawienia
    await loadSettings();

    // Walidacja URL aktywnej karty
    await validateCurrentUrl();

    // Event Listeners
    elements.apiKeyInput.addEventListener('input', validateForm);
    elements.modelInput.addEventListener('input', validateForm);
    elements.fileInput.addEventListener('change', handleFileSelect);
    elements.form.addEventListener('submit', handleSubmit);
    
    // Drag & Drop visual feedback
    ['dragenter', 'dragover'].forEach(eventName => {
        elements.dropZone.addEventListener(eventName, highlightDropZone, false);
    });
    ['dragleave', 'drop'].forEach(eventName => {
        elements.dropZone.addEventListener(eventName, unhighlightDropZone, false);
    });
});

function highlightDropZone() {
    elements.dropZone.classList.add('has-file');
}

function unhighlightDropZone() {
    if (!elements.fileInput.files.length) {
        elements.dropZone.classList.remove('has-file');
    }
}

// === ZARZĄDZANIE STORAGE ===
async function loadSettings() {
    try {
        const result = await chrome.storage.local.get(['apiKey', 'model']);
        
        if (result.apiKey) {
            elements.apiKeyInput.value = result.apiKey;
        }
        
        if (result.model) {
            elements.modelInput.value = result.model;
        } else {
            elements.modelInput.value = 'google/gemini-2.0-flash-exp:free';
        }
        
        validateForm();
    } catch (error) {
        console.error('Błąd ładowania ustawień:', error);
    }
}

async function saveSettings() {
    try {
        await chrome.storage.local.set({
            apiKey: elements.apiKeyInput.value.trim(),
            model: elements.modelInput.value.trim()
        });
    } catch (error) {
        console.error('Błąd zapisu ustawień:', error);
    }
}

// === WALIDACJA URL ===
async function validateCurrentUrl() {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        
        if (!tab || !tab.url) {
            showError('Nie można odczytać adresu URL aktywnej karty.');
            elements.processBtn.disabled = true;
            return false;
        }

        if (!VALID_URL_REGEX.test(tab.url)) {
            showError('Nieprawidłowa strona. Wtyczka działa tylko w formularzu "Dodaj koszt" na FakturaXL.');
            elements.processBtn.disabled = true;
            return false;
        }

        return true;
    } catch (error) {
        console.error('Błąd walidacji URL:', error);
        showError('Wystąpił błąd podczas weryfikacji strony.');
        return false;
    }
}

// === WALIDACJA FORMULARZA ===
function validateForm() {
    const apiKey = elements.apiKeyInput.value.trim();
    const model = elements.modelInput.value.trim();
    const file = elements.fileInput.files[0];

    const isValid = apiKey.length > 0 && model.length > 0 && file;
    elements.processBtn.disabled = !isValid;
}

// === OBSŁUGA WYBORU PLIKU ===
function handleFileSelect(event) {
    const file = event.target.files[0];
    
    if (file) {
        const sizeMB = (file.size / 1024 / 1024).toFixed(2);
        elements.fileNameText.textContent = `${file.name} (${sizeMB} MB)`;
        elements.filePreview.classList.remove('hidden');
        elements.dropZone.style.display = 'none'; // Hide large dropzone
    } else {
        elements.filePreview.classList.add('hidden');
        elements.dropZone.style.display = 'flex';
        elements.dropZone.classList.remove('has-file');
    }
    
    validateForm();
}

// === GŁÓWNA FUNKCJA PRZETWARZANIA ===
async function handleSubmit(event) {
    event.preventDefault();
    
    // Walidacja URL przed przetwarzaniem
    const urlValid = await validateCurrentUrl();
    if (!urlValid) {
        return;
    }

    // Zapisz ustawienia
    await saveSettings();

    // Pobierz dane formularza
    const apiKey = elements.apiKeyInput.value.trim();
    const model = elements.modelInput.value.trim();
    const file = elements.fileInput.files[0];

    if (!file) {
        showError('Wybierz plik faktury.');
        return;
    }

    // UI - Stan ładowania
    setLoadingState(true);
    hideMessages();
    showStatus('Przygotowywanie pliku...');

    try {
        // 1. Konwertuj plik do Base64
        const { base64, mimeType } = await fileToBase64(file);
        
        showStatus('Analiza faktury przez AI...');

        // 2. Wyślij do OpenRouter
        const invoiceData = await sendToOpenRouter(apiKey, model, base64, mimeType);
        
        showStatus('Wypełnianie formularza...');

        // 3. Wstrzyknij dane do formularza
        await injectDataToPage(invoiceData);

        // 4. Wstrzyknij plik do Dropzone
        showStatus('Załączanie pliku...');
        await injectFileToPage(base64, file.name, mimeType);

        // Sukces
        showStatus('Sukces: Formularz został uzupełniony.');
        
        // Zamknij popup po 2 sekundach
        setTimeout(() => {
            window.close();
        }, 2500);

    } catch (error) {
        console.error('Błąd przetwarzania:', error);
        showError(error.message || 'Wystąpił nieoczekiwany błąd podczas przetwarzania.');
    } finally {
        setLoadingState(false);
    }
}

// === KONWERSJA PLIKU DO BASE64 ===
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        
        reader.onload = () => {
            const base64 = reader.result.split(',')[1]; // Usuń prefix "data:..."
            resolve({
                base64: base64,
                mimeType: file.type
            });
        };
        
        reader.onerror = () => {
            reject(new Error('Nie udało się odczytać pliku.'));
        };
        
        reader.readAsDataURL(file);
    });
}

// === KOMUNIKACJA Z OPENROUTER API ===
async function sendToOpenRouter(apiKey, model, base64, mimeType) {
    const url = 'https://openrouter.ai/api/v1/chat/completions';
    
    // Sprawdź czy to PDF czy obraz
    const isPDF = mimeType === 'application/pdf' || mimeType.includes('pdf');
    
    let payload;
    
    if (isPDF) {
        // Dla PDF używamy formatu 'file' z pluginem file-parser
        const dataUrl = `data:application/pdf;base64,${base64}`;
        
        payload = {
            model: model,
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: SYSTEM_PROMPT
                        },
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
                    pdf: {
                        engine: 'pdf-text'
                    }
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
        // Dla obrazów używamy formatu 'image_url'
        const dataUrl = `data:${mimeType};base64,${base64}`;
        
        payload = {
            model: model,
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: SYSTEM_PROMPT
                        },
                        {
                            type: 'image_url',
                            image_url: {
                                url: dataUrl
                            }
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

    // === DEBUG LOGGING: Payload wysyłany do AI ===
    console.log("%c🚀 [DEBUG] Payload wysyłany do AI:", "color: blue; font-weight: bold;", JSON.stringify(payload, null, 2));

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': 'https://fakturaxl.pl',
                'X-Title': 'FXL AI OCR Extension'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            let errorMsg = 'Błąd połączenia z API.';
            try {
                const errorData = await response.json();
                if (errorData.error && errorData.error.message) {
                    errorMsg = `API Error: ${errorData.error.message}`;
                }
            } catch (e) {
                const errorText = await response.text();
                errorMsg = `API Error (${response.status}): ${errorText.substring(0, 100)}`;
            }
            throw new Error(errorMsg);
        }

        const data = await response.json();
        
        // === DEBUG LOGGING: Surowa odpowiedź z AI ===
        console.log("%c📥 [DEBUG] Surowa odpowiedź z AI:", "color: green; font-weight: bold;", JSON.stringify(data, null, 2));
        
        if (!data.choices || !data.choices[0] || !data.choices[0].message) {
            throw new Error('Otrzymano nieprawidłową odpowiedź z serwera AI.');
        }

        const content = data.choices[0].message.content;
        let invoiceData;
        try {
            invoiceData = JSON.parse(content);
        } catch (e) {
            console.error("JSON Parse Error. Content received:", content);
            throw new Error('AI zwróciło dane w niepoprawnym formacie.');
        }

        // Walidacja podstawowych pól
        if (!invoiceData.numer) {
            throw new Error('Nie udało się odczytać numeru faktury.');
        }

        console.log('✅ [DEBUG] Sparsowane dane faktury:', invoiceData);
        return invoiceData;

    } catch (error) {
        throw error;
    }
}

// === WSTRZYKIWANIE DANYCH DO STRONY ===
async function injectDataToPage(invoiceData) {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: fillInvoiceFormOnPage,
            args: [invoiceData]
        });

    } catch (error) {
        console.error('Błąd wstrzykiwania danych:', error);
        throw new Error('Nie udało się przekazać danych do formularza.');
    }
}

// === WSTRZYKIWANIE PLIKU DO STRONY ===
async function injectFileToPage(base64, fileName, mimeType) {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: uploadFileToDropzoneOnPage,
            args: [base64, fileName, mimeType]
        });

    } catch (error) {
        console.error('Błąd wstrzykiwania pliku:', error);
        throw new Error('Nie udało się załączyć pliku.');
    }
}

// === FUNKCJE WSTRZYKIWANE DO STRONY ===

// Funkcja wypełniająca formularz (wykonywana w kontekście strony)
function fillInvoiceFormOnPage(invoiceData) {
    // === MAPY DANYCH ===
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
    
    // NOWA FUNKCJA: Wymuszenie wpisania wartości (usuwanie readonly)
    const forceSetVal = (selector, value) => {
        const $el = $(selector);
        if ($el.length && $el.is(':visible')) {
            // Zdejmij blokady
            $el.prop('readonly', false).prop('disabled', false).removeClass('disabled').removeClass('readonly');
            $el.val(value);
            // Triggeruj wszystko co możliwe
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

    // Główna funkcja wypełniająca
    (async function() {
        try {
            console.log('FXL AI: Rozpoczynam wypełnianie formularza...');

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
                        // Selektory oparte na analizie HTML (Priority: #wartosc_netto_rabat_X)
                        const totalNetValue = parseFloat(item.wartosc_linii_netto).toFixed(2);
                        const netSelectors = [
                            `#wartosc_netto_rabat_${rowIndex}`, // To jest poprawne pole widoczne na FakturaXL
                            `#wartosc_netto_${rowIndex}`,       // Czasami ukryte pole, ale warto spróbować
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
                                `#wartosc_brutto_rabat_${rowIndex}`, // Prawdopodobne pole brutto
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
                        // Jeśli mamy cenę z faktury, użyj jej
                        if (item.cena_jednostkowa_na_fakturze) {
                            unitPrice = parseFloat(item.cena_jednostkowa_netto);
                        } else {
                            // Jeśli nie, wylicz (Printworld case)
                            unitPrice = parseFloat(item.wartosc_linii_netto) / quantity;
                        }
                        
                        // Używamy 4 miejsc po przecinku
                        setVal(`#netto_${rowIndex}`, unitPrice.toFixed(4));
                    }
                }
            }

            // 4. TERMIN PŁATNOŚCI
            setVal('#termin_platnosci_dni', invoiceData.termin_platnosci_dni || '14');

            // 5. Przeliczenie sum
            if (typeof oblicz_sumy === "function") {
                oblicz_sumy();
            }

            console.log('FXL AI: Zakończono wypełnianie formularza.');
        } catch (error) {
            console.error('FXL AI: Błąd podczas wypełniania formularza:', error);
        }
    })();
}

// Funkcja uploadująca plik (wykonywana w kontekście strony)
function uploadFileToDropzoneOnPage(base64, fileName, mimeType) {
    console.log(`FXL AI: Załączam plik ${fileName}...`);

    const byteCharacters = atob(base64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: mimeType });
    const file = new File([blob], fileName, { type: mimeType });

    // Funkcja pomocnicza do input fallback
    function triggerInputFallback(fileObj) {
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
    }

    if (typeof Dropzone !== 'undefined' && Dropzone.instances.length > 0) {
        try {
            const myDropzone = Dropzone.instances[0];
            console.log(`FXL AI: Próba dodania pliku do Dropzone API...`);
            
            // Hack: Dodajemy plik do Dropzone, ale łapiemy błędy UI
            // Dropzone.addFile wywołuje thumbnail generation, co sypie błędami w trybie headless
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

// === ZARZĄDZANIE UI ===
function setLoadingState(isLoading) {
    elements.processBtn.disabled = isLoading;
    elements.apiKeyInput.disabled = isLoading;
    elements.modelInput.disabled = isLoading;
    elements.fileInput.disabled = isLoading;

    if (isLoading) {
        elements.btnText.classList.add('hidden');
        elements.btnLoader.classList.remove('hidden');
    } else {
        elements.btnText.classList.remove('hidden');
        elements.btnLoader.classList.add('hidden');
    }
}

function showError(message) {
    elements.errorText.textContent = message;
    elements.errorContainer.classList.remove('hidden');
    elements.statusContainer.classList.add('hidden');
}

function showStatus(message) {
    elements.statusText.textContent = message;
    elements.statusContainer.classList.remove('hidden');
    elements.errorContainer.classList.add('hidden');
}

function hideMessages() {
    elements.errorContainer.classList.add('hidden');
    elements.statusContainer.classList.add('hidden');
}
