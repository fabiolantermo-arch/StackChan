# Camera K210 (M5Stack UnitV) — preparazione

**Stato (23 novembre 2026): la camera è arrivata (M5Stack UnitV), il nostro `boot.py` ci gira sopra e il robot la sente sulla PORT.C (filo G17, circa 15 immagini al secondo, nessuna persa); non guida ancora la testa.** Così come esce dalla scatola ha già tutto: MaixPy v0.4.0 del 2019 (variante M5StickV: all’avvio il programma di fabbrica dava un errore sul chip di alimentazione, che la UnitV non ha), `KPU` con `load`/`init_yolo2`/`run_yolo2`, il sensore OV7740, la seriale e la lucina, e **il modello dei visi già a `0x300000`** (388 776 byte): non serve riscrivere il firmware né il modello. Provato dal Mac senza installare (60 immagini, 67 ms l’una, nessun errore, nessun viso perché davanti non c’era nessuno), poi installato con `firmware/k210/install.py` (copia del `boot.py` di fabbrica in `work/k210-factory/`, scrittura, rilettura identica, riavvio): fermato con Ctrl-C mentre girava e ripartito senza errori. Sul Mac la camera compare come `/dev/cu.usbserial-…` («M5Stack Intf»). Prima: preparato, controllato sul Mac e provato sul robot senza camera il 15 novembre 2026 (serve l’host `host-2026-11-15b` o successivo). Scritto il 14 novembre 2026, prima dell’arrivo della camera. Sul robot oggi la K210 non muove niente: quando è accesa dal menu, il robot ascolta soltanto e scrive sul registro USB quello che sente.

## A cosa serve

La K210 ha un suo processore fatto per le reti neurali: trova i visi da sola e manda al robot solo pochi numeri (dove sta il viso più grande), non immagini. Così la ricerca del viso non toglie più memoria e tempo alla voce.

## Come si parlano

- Cavo Grove dalla camera alla **PORT.C** del robot (G17 e G18, 5 V). È libera: i motori usano G6/G7.
- Seriale a 115200, **solo dalla camera al robot**. Il robot non manda niente.
- Per ogni immagine guardata la camera manda 12 byte, con o senza viso:

| Byte | Contenuto |
|---|---|
| 0, 1 | `R`, `K` |
| 2 | versione (1) |
| 3 | numero dell’immagine (0…255, poi di nuovo 0) |
| 4 | quanti visi |
| 5, 6 | centro del viso più grande: 0…255 da sinistra e dall’alto |
| 7, 8 | larghezza e altezza del viso: 0…255 dell’immagine |
| 9 | quanto è sicura, 0…100 |
| 10 | millisecondi spesi per l’immagine |
| 11 | controllo (CRC-8, polinomio 7, dei byte 2…10) |

Lo stesso formato è in tre posti, da cambiare insieme: `firmware/stackchan-mod/k210.js` (robot), `firmware/k210/boot.py` (camera), `scripts/virtual-k210.mjs` (camera finta). Una prova in `npm test` controlla che lo script della camera e il robot scrivano gli stessi byte.

## File

- `boot.py`: lo script della camera (MaixPy). Parte da solo all’accensione.
- `../stackchan-mod/k210.js`: il lato robot. Legge i byte anche a pezzi, scarta rumore e pacchetti rovinati, conta le immagini perse.
- `../../scripts/virtual-k210.mjs`: una camera finta per le prove.
- `pretend-maixpy.py`: fa girare `boot.py` intero sul Mac, con moduli MaixPy finti al posto della camera (sensore, ricerca dei visi, seriale, lucina, orologio), e dice quali byte ha mandato e che cosa ha chiesto alla camera.

## Che cosa è stato controllato (15 novembre 2026, utente: «inizia a verificare se il codice della K210 funziona tutto»)

Controllato sul Mac, senza camera e senza robot:

- **Lo script della camera gira intero** con MaixPy finto: 300 immagini di fila (nessun viso, un viso, due visi, un viso sul bordo), ogni pacchetto letto dal lato robot, nessuno perso nemmeno quando il numero dell’immagine torna da 255 a 0; senza il modello dei visi non manda niente, accende la luce rossa e scrive il motivo; senza il modulo della lucina funziona lo stesso. Sono tre prove in `npm test`.
- **Camera finta → porta seriale → lato robot**: `virtual-k210.mjs --port` su una porta seriale finta del Mac (pty), i byte ricevuti dati a `createK210` sul secondo filo: il robot cambia filo da solo, legge tutto, e con il disturbo (`dirty`) scarta solo i pacchetti rovinati e li conta.
- **La seriale dell’host che è sul robot** (Moddable 10.1.0, `modules/embedded/io/serial/esp32/serial.c`, letto riga per riga): il modulo `embedded:io/serial` è nell’host; la porta 2 esiste sull’ESP32-S3 (tre porte) e nessun altro la usa (i servi sono sulla 1, G6/G7); i piedini 17 e 18 non sono presi da altro; si può aprire con il solo piedino di ricezione; `read(buffer)` riempie il buffer dato e restituisce quanti byte ha messo, come si aspetta `k210.js`; la memoria della porta è di 128 byte (dieci pacchetti); chiudere e riaprire sull’altro filo restituisce piedino e interruzione.
- **Gli argomenti della seriale di MaixPy** (sorgente di MaixPy, `machine_uart.c`): `UART(UART.UART1, 115200, 8, 0, 0, …)` vuol dire 8 bit, nessuna parità, uno stop (lo 0 è letto come 1): uguale a come ascolta il robot.

**Provato sul robot vero, senza camera (15 novembre 2026, 23:10–23:45)**: l’ESP32-S3 può collegare al suo interno invio e ricezione della stessa porta sullo stesso piedino. Un MOD di prova (non nel programma normale; le righe aggiunte a `mod.js` sono in `loopback-test.diff`) ha aperto la porta 2 con lo stesso piedino in invio e in ricezione, ha mandato i pacchetti della camera finta e li ha riletti con `createK210`, cioè con il codice che ascolterà la camera. **Ha trovato due errori nell’host, che sul Mac non si potevano vedere; tutti e due corretti** (`firmware/host/patches/moddable/serial-port-2-and-overflow.patch`, host `host-2026-11-15b`, sul robot dalle 23:42):

1. **La porta 2 non si apriva** (`uart_isr_register failed`). Nella seriale di Moddable le righe per la porta 2 stanno dietro `#if UART_NUM_MAX > 2`; da ESP-IDF 5 `UART_NUM_MAX` è un valore di un elenco e non una macro, il preprocessore lo legge come 0, e la «porta 2» riceveva i registri e l’interruzione della porta 1, **quella dei motori** (già occupata: per questo falliva). Con «K210: sì» il robot avrebbe riprovato ogni 3 secondi, toccando ogni volta le interruzioni della linea dei motori. Ora la build dell’host controlla che la porta 2 ci sia davvero.
2. **Dopo un trabocco il robot leggeva posizioni vecchie.** La porta tiene 128 byte (dieci pacchetti, circa mezzo secondo di camera). Se il programma resta occupato più a lungo, la memoria trabocca, e da lì in poi ogni lettura dava quello che era arrivato una scrittura prima: misurato, almeno 2 pacchetti di ritardo, per sempre, senza nessun segno (più dati sporchi nel passaggio: 8 pacchetti rovinati, numeri di immagine che tornavano indietro). Ora alla prima lettura dopo un trabocco l’host svuota la porta e riparte pulito, come fa il driver di ESP-IDF: misurato dopo la correzione, ritardo minimo 0 come nel funzionamento normale, nessun pacchetto rovinato, e i pacchetti persi contati giusti (148 su 148).

Misure dell’ultima prova (host `15b`): 110 pacchetti mandati a 20 al secondo e 110 letti, sul filo G18 e, dopo 3 s di silenzio, da solo sul filo G17; apertura in sola ricezione riuscita su tutti e due i fili. Il robot mentre lavora (camera e ricerca del viso) legge i pacchetti con 0–6 pacchetti di ritardo, in media 1: è il tempo che il programma impiega a tornare alla porta.

**Mai rifare questa prova con la camera collegata**: il robot manderebbe sullo stesso filo su cui manda lei.

Non controllabile senza la camera: che il suo firmware abbia proprio queste chiamate e il modello dei visi a `0x300000`; su quale dei due fili parla; se la presa blu dà i 5 V alla camera anche a batteria; che la presa blu sia davvero G18/G17 (dalla scheda del CoreS3; la pagina di M5Stack non era raggiungibile durante il controllo); le immagini vere (trova il viso dell’utente? quante al secondo? quanto vede?).

## Quando arriva la camera

1. **Firmware della camera**: installare MaixPy e il modello dei visi (`face_model_at_0x300000.kfpkg`) con lo strumento di M5Stack/Sipeed (kflash). Va fatto dal Mac con il cavo USB-C della camera. *Da verificare: quale firmware c’è di fabbrica e se il modello è già dentro.*
2. **Script**: copiare `boot.py` nella camera (microSD oppure MaixPy IDE).
3. **Cavo**: Grove sulla PORT.C del robot: è la presa **blu**, di fianco al sensore, accanto a quella nera (porta B); quella rossa sul fianco è la porta A (visto dall’utente sul robot il 15 novembre 2026). Le tre porte stanno sulla testa: con la camera montata sulla testa il cavo resta corto e non si tende quando gira.
4. **Accendere l’ascolto**: sul robot, menu grande → «K210: sì». Resta acceso anche dopo un riavvio.
5. **Leggere il registro USB**: ogni 5 secondi una riga come

   ```
   [robottino] k210 G18 frames=75 faces=70 ms=52 lost=0 bad=0 noise=0 at 48,31 wide 20 sure 90 in 5000 ms
   ```

   Se resta `silent`, il robot prova da solo l’altro filo ogni 3 secondi. Se resta silenziosa su tutti e due: guardare la luce della camera (rossa = lo script si è fermato, di solito manca il modello).

## Cose da decidere con la camera in mano

- **Trova davvero il viso dell’utente?** Va provato su immagini vere, da dove è montata (seduto, in piedi, girato). Il primo riconoscitore del robot trovava tutti i ritratti di prova e mai il viso vero.
- **Quante immagini al secondo** (riga `ms=`).
- **Dove montarla**: sulla testa (si muove con lei, stesso metodo di oggi) o fissa sulla base (vede sempre la stessa scena, niente attesa a testa ferma, ma copre solo la zona davanti).
- **Quanto vede**: gli angoli in `K210_FOV` vengono dalle schede tecniche (65° o 80° in diagonale secondo il modello), non sono misurati.
- **Consumo** sulla batteria da 550 mAh.

Solo dopo si collega alla testa: il punto è `selfAnswer` in `live-device.js`, e `faceDirection` in `k210.js` fa già il conto degli angoli.

## Provare senza la camera

```sh
node scripts/virtual-k210.mjs                 # stampa i byte
node --test firmware/stackchan-mod/k210.test.mjs
python3 -I -B firmware/k210/pretend-maixpy.py firmware/k210/boot.py '{"pictures":[[],[[48,132,64,72,0.9]]]}'   # lo script della camera, intero
```

Con un adattatore USB-seriale a 3,3 V sulla PORT.C (TX dell’adattatore → G18, massa → massa, **mai il filo dei 5 V**) il Mac può fare la camera: `node scripts/virtual-k210.mjs --port /dev/cu.usbserial-XXXX`.
