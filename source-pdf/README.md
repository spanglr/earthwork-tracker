# Source sheet for the Pittsburgh demo

The Pittsburgh demo is built from sheet C-2.1 ("Grading Plan", dated 08/17/2023,
printed scale 1 inch = 10 ft) of a public City of Pittsburgh Zoning Board of
Adjustment submission for Rhythm Square, 2239 Centre Avenue.

The drawing belongs to its authors, so the PDF is not included in this
repository. To install the demo:

1. Open this link in a web browser and save the file (the city's server
   refuses command-line downloads such as `curl`):

   <https://www.pittsburghpa.gov/files/assets/city/v/1/dcp/documents/zoning-board-of-adjustment/24278_zba_040_of_2024_dcp-zdr-2023-08746_2239_centre_ave.pdf>

2. Save it in this folder as **`rhythm-square-zba.pdf`**.

3. Restart the app (`npm start`), or press **Build this demo** under
   *Project setup*. The demo is extracted from the PDF in about ten seconds.

The file this was developed against is 1,434,371 bytes, three pages, with
SHA-256 `488cfd1f6f7885d4061076230237736275136b1c3bf388c58a0318ab95f84b8a`.
If the city replaces the file, the demo's saved review decisions may no longer
line up and the build will say so.
