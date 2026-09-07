# Consulens 3D-viewer (viewer.consulens.be)

Zelfstandige, statische IFC/BIM-viewer (IFClite + Three.js). Bedoeld om via een
`<iframe>` ingesloten te worden op projectpagina's (consulens.be, en later
andere sites).

## Lokaal draaien
```bash
nvm use        # Node 22 (.nvmrc)
npm install
npm run dev     # http://localhost:5173
```
Open bv. `http://localhost:5173/?model=/models/RIOAK4%20-%20Olen%20-%20Architectuur.ifc,/models/RIOAK4%20-%20Olen%20-%20Stabiliteit.ifc&embed=1&title=RIOAK4`

## Bouwen
```bash
npm run build   # output in dist/
```

## Gebruik (URL-parameters)
- `model` — pad naar een IFC in `/models/`. Meerdere modellen: komma-gescheiden (federatie).
- `embed=1` — verbergt de eigen kop (strak in een iframe).
- `title=` — titel (spaties als %20).

Voorbeeld embed-URL:
`https://viewer.consulens.be/?model=/models/arch.ifc,/models/stab.ifc&embed=1&title=Project`

## IFC-bestanden
Zet ze in `public/models/`. Ze worden mee gedeployed en op hetzelfde domein
geserveerd (same-origin → geen CORS). Tip: gebruik bestandsnamen zonder spaties.
Let op: Cloudflare Pages heeft een limiet van 25 MB per bestand.

## Hosting (Cloudflare Pages)
- Build command: `npm run build` · Output: **`dist`** · Node: 22 (.nvmrc)
- Custom domain: `viewer.consulens.be`
- `public/_headers` staat toe dat consulens.be de viewer in een iframe insluit
  (`frame-ancestors`). Voeg daar extra domeinen toe als je hem elders insluit.

## Kan: 
3D-navigatie, klik→eigenschappen, structuurboom, federatie (meerdere IFC's),
snijvlakken (Z=hoogte), meten, isoleren/verbergen, X-ray, disciplines aan/uit,
kleur per klasse + legende, verdieping-plannen (over alle modellen), aanzichten,
volledig scherm, schermafbeelding, en opgeslagen standpunten.
