# Robottino per iPhone

*Versione italiana · [English version](README-en.md)*

Un'app SwiftUI nativa per iOS 18 o successivo. Non è distribuita su App Store né su TestFlight: apri `Robottino.xcodeproj` in Xcode, scegli il tuo identificativo del pacchetto e il tuo team di firma, e avviala sul tuo telefono. L'interfaccia è in italiano.

Che cosa fa:

- **Robot**: se il robot è in linea, il token dell'app e l'interruttore per seguire il tuo viso durante una conversazione.
- **Aspetto**: il volto, il modello vocale e la voce, e la lingua (italiano o inglese).
- **Studio**: un editor di danze, le espressioni e un collegamento simulato, utilizzabili senza il robot.
- **Test**: l'abbinamento con un codice e il Wi-Fi via Bluetooth; **Live** (la camera del robot, un joystick per la testa, l'inseguimento del viso, una chiamata attraverso il robot, immagini sul suo schermo, danze); una conversazione a voce dal telefono; **Ricordi**, ciò che Robottino ricorda, da leggere, aggiungere, modificare e cancellare.

L'app non parla mai direttamente con il robot: tutti e due si collegano al Worker, che fa da ponte. Il token dell'app (`ROBOT_API_TOKEN`) lo incolla l'utente e resta nel Portachiavi; le chiavi dei provider non vanno mai nell'app, e aggiornare l'app non deve mai disinstallarla (si perderebbero il Portachiavi e i suoi dati).

Il codice sta in tre file: `RobotLiveCore.swift` (logica pura, provata da `test-connection.swift`), `RobotLive.swift` (audio, camera e schermate Live) e `Sources.swift` (l'interfaccia principale).

```sh
node ios/test-connection.mjs   # i test della logica, sul Mac
node ios/build-check.mjs       # compila e controlla la firma, non installa
```

Vedi anche [TEST-ROBOT-it.md](TEST-ROBOT-it.md) e [STUDIO-it.md](STUDIO-it.md).
