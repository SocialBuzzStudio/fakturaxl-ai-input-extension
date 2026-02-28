# FXL AI - Rozszerzenie Chrome do OCR Faktur

Profesjonalne rozszerzenie Chrome do automatycznego rozpoznawania i wypełniania faktur kosztowych w serwisie FakturaXL przy użyciu sztucznej inteligencji.

## ⚠️ WAŻNE INFORMACJE

**To jest nieoficjalne, niezależne narzędzie stworzone przez zewnętrznego developera.**

- **NIE JESTEŚMY** FakturaXL ani nie współpracujemy oficjalnie z tym serwisem
- **NIE REPREZENTUJEMY** firmy FakturaXL
- Rozszerzenie powstało jako **inicjatywa społecznościowa** w celu uzupełnienia braków funkcjonalnych serwisu FakturaXL
- Jesteśmy **zewnętrznym providerem** świadczącym niezależne narzędzie dla użytkowników FakturaXL
- Używasz tego rozszerzenia **na własną odpowiedzialność**
- FakturaXL nie ponosi odpowiedzialności za działanie tego rozszerzenia

## Opis

FXL AI to narzędzie, które wykorzystuje technologię OCR (Optical Character Recognition) opartą na modelach AI do automatycznego wyciągania danych z faktur (PDF lub obrazów) i wypełniania formularzy na platformie FakturaXL. Rozszerzenie znacząco przyspiesza proces wprowadzania faktur kosztowych, eliminując potrzebę ręcznego przepisywania danych.

**Powód powstania:** FakturaXL w wersji podstawowej nie oferuje automatycznego rozpoznawania faktur. To rozszerzenie wypełnia tę lukę, umożliwiając użytkownikom automatyzację procesu wprowadzania faktur.

## Funkcje

- Automatyczne rozpoznawanie danych z faktur (PDF, JPG, PNG)
- Integracja z OpenRouter API (obsługa wielu modeli AI z vision)
- Automatyczne wypełnianie formularza faktury kosztowej na FakturaXL
- Automatyczne załączanie pliku źródłowego do Dropzone
- Zapisywanie ustawień (klucz API, model AI)
- Nowoczesny interfejs użytkownika w stylu SaaS
- Drag & Drop dla plików

## Wymagania

1. **Przeglądarka:** Google Chrome (wersja 88+) lub Microsoft Edge
2. **Konto OpenRouter:** [https://openrouter.ai/](https://openrouter.ai/)
3. **Klucz API OpenRouter:** Wymagany do korzystania z modeli AI
4. **Konto FakturaXL:** [https://fakturaxl.pl/](https://fakturaxl.pl/)

## Instalacja

### 1. Pobierz rozszerzenie

```bash
git clone https://github.com/YOUR_ORG/fakturaxl-ai-input-extension.git
cd fakturaxl-ai-input-extension
```

### 2. Zainstaluj w Chrome

1. Otwórz Chrome i wejdź na: `chrome://extensions/`
2. Włącz **Tryb programisty** (przełącznik w prawym górnym rogu)
3. Kliknij **Załaduj rozpakowane rozszerzenie**
4. Wybierz folder z rozszerzeniem (`fakturaxl-ai-input-extension`)
5. Rozszerzenie zostanie zainstalowane

## Konfiguracja

### Uzyskanie klucza API OpenRouter

1. Zarejestruj się na [OpenRouter](https://openrouter.ai/)
2. Przejdź do sekcji **API Keys**
3. Wygeneruj nowy klucz API
4. Skopiuj klucz (zaczyna się od `sk-or-v1-...`)

### Wybór modelu AI

Domyślnie używany jest model: `google/gemini-2.0-flash-exp:free`

Inne rekomendowane modele z obsługą vision:
- `google/gemini-2.0-flash-exp:free` (darmowy, najszybszy)
- `google/gemini-pro-vision` (płatny, bardziej dokładny)
- `anthropic/claude-3-opus` (płatny, najlepszy dla skomplikowanych faktur)

**Ważne:** Model musi obsługiwać analizę obrazów (vision capability).

## Użytkowanie

### 1. Przejdź do formularza FakturaXL

Otwórz formularz dodawania faktury kosztowej:
```
https://fakturaxl.pl/?page=faktura_vat_koszty
```

### 2. Uruchom rozszerzenie

1. Kliknij ikonę rozszerzenia **FXL AI** na pasku narzędzi Chrome
2. W popupie wprowadź:
   - **Klucz OpenRouter** (zostanie zapisany lokalnie)
   - **Model AI** (opcjonalnie zmień domyślny)
   - **Wybierz plik faktury** (PDF, JPG lub PNG)

### 3. Przetwórz fakturę

1. Kliknij **Przetwórz fakturę**
2. Rozszerzenie:
   - Wyśle fakturę do AI
   - Wyciągnie wszystkie dane
   - Automatycznie wypełni formularz
   - Załączy plik do Dropzone
3. Sprawdź wypełnione dane i zapisz fakturę

## Struktura danych wyjściowych

Rozszerzenie wyciąga następujące dane z faktury:

```json
{
  "numer": "FV/2025/001",
  "data_wystawienia": "2025-01-04",
  "data_sprzedazy": "2025-01-04",
  "miejsce": "Warszawa",
  "sprzedawca": {
    "nazwa": "Firma ABC Sp. z o.o.",
    "nip": "1234567890",
    "ulica": "ul. Przykładowa 1",
    "kod": "00-001",
    "miejscowosc": "Warszawa",
    "konto": "12 1234 5678 9012 3456 7890 1234"
  },
  "pozycje": [
    {
      "nazwa": "Usługa projektowa",
      "ilosc": 1,
      "jm": "szt.",
      "cena_netto": 1000.00,
      "vat": "23"
    }
  ],
  "termin_platnosci_dni": "14"
}
```

## Bezpieczeństwo

- Klucz API jest przechowywany lokalnie w Chrome Storage
- Dane nie są wysyłane na żadne inne serwery oprócz OpenRouter API
- Rozszerzenie działa tylko na domenach `*.fakturaxl.pl`
- Nie są zbierane żadne dane analityczne

## Struktura projektu

```
fakturaxl-ai-input-extension/
├── manifest.json                    # Manifest rozszerzenia Chrome
├── popup/
│   ├── popup.html                   # Interfejs użytkownika
│   ├── popup.css                    # Style (SaaS design)
│   └── popup.js                     # Logika rozszerzenia
├── tamper-monkey-alternative/
│   └── fxl-ai.user.js              # Alternatywa Tampermonkey (bez Chrome Web Store)
├── logo/
│   ├── favicon-96x96.png
│   └── web-app-manifest-192x192.png
├── LICENSE
└── README.md
```

## Rozwiązywanie problemów

### Rozszerzenie nie działa

- Upewnij się, że jesteś na stronie: `https://fakturaxl.pl/?page=faktura_vat_koszty`
- Sprawdź czy klucz API OpenRouter jest prawidłowy
- Otwórz DevTools (F12) i sprawdź konsolę pod kątem błędów

### AI nie rozpoznaje danych

- Spróbuj użyć innego modelu AI
- Upewnij się, że faktura jest czytelna (dobra jakość skanu)
- Sprawdź czy model obsługuje vision (obrazy/PDF)

### Formularz nie wypełnia się automatycznie

- Odśwież stronę FakturaXL
- Sprawdź konsolę przeglądarki (F12) pod kątem błędów JavaScript
- Upewnij się, że struktura formularza FakturaXL się nie zmieniła

## Wsparcie techniczne

Jeśli napotkasz problemy:
1. Sprawdź konsolę przeglądarki (F12) pod kątem błędów
2. Upewnij się, że masz aktywne konto OpenRouter z dostępnymi limitami
3. Zweryfikuj poprawność klucza API

## Licencja

Ten projekt jest licencjonowany na podstawie licencji MIT. Zobacz plik [LICENSE](LICENSE) w celu uzyskania szczegółów.

## Autor

Rozszerzenie stworzone przez **[SocialBuzzStudio Sp. z o.o.](https://socialbuzzstudio.com)** jako projekt open-source dla społeczności użytkowników platformy FakturaXL.

**Nie jesteśmy powiązani z FakturaXL** - jesteśmy zewnętrznym providerem oferującym darmowe narzędzie do automatyzacji pracy z tym serwisem.

## Changelog

### v1.0.0 (2025-01-04)
- Pierwsza wersja publiczna
- Integracja z OpenRouter API
- Obsługa PDF i obrazów
- Automatyczne wypełnianie formularzy FakturaXL
- Nowoczesny interfejs użytkownika

