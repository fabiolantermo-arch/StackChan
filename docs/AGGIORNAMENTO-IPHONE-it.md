# Aggiornare Robottino su iPhone

Doppio clic su **Update Robottino.command**, nella cartella principale del progetto. Collegare e sbloccare l'iPhone 17 Pro Max; il Mac deve essere autorizzato dal dispositivo e Xcode deve avere un certificato Apple Development valido.

Lo script compila i sorgenti correnti, firma solo com.example.robottino, verifica bundle e team, installa l'aggiornamento e apre l'app. Non disinstalla l'app, non incorpora il token del backend e non modifica Cloudflare o il firmware del robot. I ricordi restano sul server e il token resta nel Portachiavi dell'iPhone.

Log e build sono in work/iphone-update, esclusi da Git. `--check` verifica il progetto e la presenza di un certificato senza installare. Se si cambia iPhone, impostare ROBOT_DEVICE_ID sull'identificativo del dispositivo autorizzato.

Prima installazione completata e firma verificata il 6 novembre 2026. Al primo uso inserire nell'app il token dedicato di Robottino; non inserire le chiavi OpenAI o ElevenLabs.
