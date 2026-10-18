// Decodificador de listas INCI: explica qué hace cada ingrediente, en el orden de la etiqueta.
(function () {
  var form = document.querySelector('[data-decoder]');
  var out = document.querySelector('[data-decoder-out]');
  if (!form || !out) return;

  // [nombres INCI y alias, función, qué hace]
  var DICT = [
    [['aqua', 'water', 'eau', 'aqua/water', 'water/aqua', 'purified water'], 'Solvent', 'The base of most formulas. It dissolves the water-soluble ingredients and carries them onto your skin.'],
    [['glycerin', 'glycerol', 'glycerine'], 'Humectant', 'Pulls water into the outer layer of skin and holds it there. One of the most studied, least irritating moisturizers there is.'],
    [['butylene glycol'], 'Humectant', 'A light humectant that also helps other ingredients dissolve and spread evenly.'],
    [['propylene glycol'], 'Humectant', 'Holds water and helps actives penetrate. Well tolerated by most people, a known irritant for a small minority.'],
    [['propanediol'], 'Humectant', 'A plant-derived glycol that hydrates and boosts how well preservatives work.'],
    [['pentylene glycol'], 'Humectant', 'Hydrates and has its own antimicrobial effect, so it lets a formula use less preservative.'],
    [['ethoxydiglycol'], 'Solvent', 'Dissolves actives such as vitamin C and helps them get into the skin.'],
    [['sodium hyaluronate', 'hyaluronic acid', 'hydrolyzed hyaluronic acid', 'sodium acetylated hyaluronate'], 'Humectant', 'Binds a lot of water at the skin surface. Molecular weight decides whether it sits on top or sinks in a little.'],
    [['urea'], 'Humectant', 'Part of skin\'s own natural moisturizing factor. Hydrates at low percentages and softens rough skin at higher ones.'],
    [['sodium pca'], 'Humectant', 'Another piece of skin\'s natural moisturizing factor. Draws in water.'],
    [['betaine'], 'Humectant', 'A gentle hydrator from sugar beets that also helps calm irritation from surfactants.'],
    [['panthenol', 'd-panthenol', 'dexpanthenol'], 'Soothing', 'Pro-vitamin B5. Hydrates and supports barrier repair, which is why it shows up in so many "calming" products.'],
    [['allantoin'], 'Soothing', 'Calms and softens skin. Common in sensitive-skin formulas.'],
    [['bisabolol'], 'Soothing', 'The calming molecule from chamomile.'],
    [['madecassoside', 'centella asiatica extract', 'asiaticoside'], 'Soothing', 'From centella ("cica"). Calms redness and supports healing.'],
    [['niacinamide'], 'Active', 'Vitamin B3. Supports ceramide production, evens tone and helps with oil and redness. Effective from about 2–5%.'],
    [['ascorbic acid', 'l-ascorbic acid'], 'Active', 'Pure vitamin C. A strong antioxidant that brightens and supports collagen, but only stable at a low pH, which is why these serums tingle.'],
    [['sodium ascorbyl phosphate', 'magnesium ascorbyl phosphate', 'ascorbyl glucoside', '3-o-ethyl ascorbic acid', 'tetrahexyldecyl ascorbate'], 'Active', 'A more stable vitamin C derivative. Gentler than pure ascorbic acid, and the skin has to convert it first.'],
    [['retinol'], 'Active', 'Vitamin A. Two conversion steps from retinoic acid; speeds up cell turnover and supports collagen. Start slow and wear sunscreen.'],
    [['retinal', 'retinaldehyde'], 'Active', 'Vitamin A one step from retinoic acid, so it works faster than retinol at the same strength.'],
    [['retinyl palmitate', 'retinyl acetate'], 'Active', 'The mildest vitamin A ester. Three conversion steps away, so it is gentle and much weaker.'],
    [['hydroxypinacolone retinoate'], 'Active', 'A retinoid ester that binds retinoid receptors directly, marketed as gentler than retinol.'],
    [['bakuchiol'], 'Active', 'A plant molecule with some retinol-like effects in studies, usually better tolerated.'],
    [['salicylic acid', 'bha'], 'Exfoliant', 'BHA. Oil-soluble, so it gets into pores and loosens what clogs them. The classic acne acid.'],
    [['glycolic acid'], 'Exfoliant', 'The smallest AHA. Loosens dead skin at the surface for smoother, brighter skin. Raises sun sensitivity.'],
    [['lactic acid'], 'Exfoliant', 'An AHA that exfoliates more gently than glycolic and also hydrates.'],
    [['mandelic acid'], 'Exfoliant', 'A large AHA molecule that penetrates slowly, which makes it gentler.'],
    [['gluconolactone'], 'Exfoliant', 'A PHA. Very gentle exfoliation plus some hydration.'],
    [['azelaic acid'], 'Active', 'Calms redness, helps with acne and fades marks. Suitable for sensitive and rosacea-prone skin.'],
    [['tranexamic acid'], 'Active', 'Targets the pathway behind dark spots and post-acne marks.'],
    [['alpha-arbutin', 'arbutin'], 'Active', 'Slows melanin production to fade dark spots.'],
    [['zinc oxide', 'ci 77947'], 'UV filter', 'A mineral sunscreen filter covering UVA and UVB. Also soothing.'],
    [['titanium dioxide', 'ci 77891'], 'UV filter', 'A mineral sunscreen filter, mostly UVB. Also used as a white pigment.'],
    [['avobenzone', 'butyl methoxydibenzoylmethane'], 'UV filter', 'A chemical UVA filter. Needs stabilizing because it breaks down in sunlight on its own.'],
    [['octocrylene'], 'UV filter', 'A UVB filter often used to stabilize avobenzone.'],
    [['homosalate', 'ethylhexyl salicylate', 'octisalate'], 'UV filter', 'A UVB filter.'],
    [['ethylhexyl methoxycinnamate', 'octinoxate'], 'UV filter', 'A UVB filter.'],
    [['bis-ethylhexyloxyphenol methoxyphenyl triazine', 'bemotrizinol', 'tinosorb s'], 'UV filter', 'A modern broad-spectrum filter that is very photostable.'],
    [['ceramide np', 'ceramide ap', 'ceramide eop', 'ceramide ns', 'ceramide eos', 'ceramide 3', 'ceramide 1', 'ceramide 6 ii'], 'Barrier lipid', 'One of the lipids that hold skin cells together. Replenishing them helps a damaged barrier.'],
    [['cholesterol'], 'Barrier lipid', 'Works with ceramides and fatty acids in the barrier. Best in the right ratio with them.'],
    [['phytosphingosine'], 'Barrier lipid', 'A building block of ceramides with a mild antimicrobial effect.'],
    [['squalane'], 'Emollient', 'A stable, lightweight oil that mimics skin\'s own sebum. Softens without feeling greasy.'],
    [['caprylic/capric triglyceride', 'caprylic capric triglyceride'], 'Emollient', 'A light oil made from coconut fatty acids. Smooths skin and dissolves oil-soluble ingredients.'],
    [['dimethicone'], 'Silicone', 'Forms a breathable, silky film that reduces water loss and makes the formula glide.'],
    [['cyclopentasiloxane', 'cyclohexasiloxane'], 'Silicone', 'A volatile silicone. It gives the product slip, then evaporates.'],
    [['petrolatum'], 'Occlusive', 'The most effective barrier against water loss there is. Seals moisture in.'],
    [['shea butter', 'butyrospermum parkii butter', 'butyrospermum parkii (shea) butter'], 'Emollient', 'A rich plant butter that softens and seals.'],
    [['cetearyl alcohol', 'cetyl alcohol', 'stearyl alcohol', 'behenyl alcohol'], 'Thickener', 'A fatty alcohol. Despite the name it isn\'t drying; it thickens creams and softens skin.'],
    [['alcohol denat.', 'alcohol denat', 'alcohol', 'sd alcohol', 'ethanol'], 'Solvent', 'Drying alcohol. Helps light textures and penetration, but high on the list it can irritate.'],
    [['carbomer'], 'Thickener', 'Turns water into a clear gel once neutralized.'],
    [['xanthan gum'], 'Thickener', 'A natural gum that thickens and stabilizes.'],
    [['hydroxyethylcellulose'], 'Thickener', 'A cellulose thickener for gels.'],
    [['sodium polyacrylate', 'acrylates/c10-30 alkyl acrylate crosspolymer'], 'Thickener', 'A polymer that thickens and stabilizes the texture.'],
    [['glyceryl stearate', 'glyceryl stearate se', 'peg-100 stearate', 'polysorbate 20', 'polysorbate 60', 'polysorbate 80', 'cetearyl olivate', 'sorbitan olivate', 'ceteareth-20'], 'Emulsifier', 'Keeps oil and water mixed so the cream doesn\'t separate.'],
    [['sodium hydroxide', 'potassium hydroxide', 'triethanolamine', 'tromethamine', 'aminomethyl propanol', 'arginine'], 'pH adjuster', 'Raises the pH to where the formula is stable and comfortable. Used up in the reaction, it isn\'t "lye on your face".'],
    [['citric acid', 'lactic acid (ph adjuster)'], 'pH adjuster', 'Lowers the pH. In small amounts it adjusts the formula rather than exfoliating.'],
    [['disodium edta', 'tetrasodium edta', 'trisodium ethylenediamine disuccinate', 'sodium phytate', 'tetrasodium glutamate diacetate'], 'Chelator', 'Binds metal ions from water so they can\'t spoil the formula or weaken the preservative.'],
    [['phenoxyethanol'], 'Preservative', 'The most common preservative today. Keeps bacteria and mold out of anything that contains water. Capped at 1%.'],
    [['ethylhexylglycerin'], 'Preservative booster', 'Helps the preservative work at a lower dose and conditions skin.'],
    [['caprylyl glycol', '1,2-hexanediol'], 'Preservative booster', 'Hydrates and strengthens the preservative system.'],
    [['sodium benzoate', 'benzoic acid'], 'Preservative', 'A food-grade preservative that works in acidic formulas.'],
    [['potassium sorbate', 'sorbic acid'], 'Preservative', 'A food-grade preservative, often paired with sodium benzoate.'],
    [['benzyl alcohol'], 'Preservative', 'A preservative that also appears naturally in some essential oils.'],
    [['chlorphenesin'], 'Preservative', 'A preservative usually combined with others.'],
    [['sodium laureth sulfate', 'sodium lauryl sulfate', 'ammonium lauryl sulfate', 'ammonium laureth sulfate'], 'Surfactant', 'A strong cleansing agent that makes rich foam. Very effective, and can strip dry or sensitive skin.'],
    [['cocamidopropyl betaine'], 'Surfactant', 'A mild co-surfactant that softens harsher cleansers and boosts foam.'],
    [['coco-glucoside', 'decyl glucoside', 'lauryl glucoside', 'caprylyl/capryl glucoside'], 'Surfactant', 'A gentle sugar-based cleanser.'],
    [['sodium cocoyl isethionate', 'sodium lauroyl methyl isethionate'], 'Surfactant', 'A mild, creamy cleanser used in gentle face washes and syndet bars.'],
    [['sodium chloride'], 'Thickener', 'Table salt. Thickens shampoos and cleansers.'],
    [['tocopherol', 'tocopheryl acetate', 'vitamin e'], 'Antioxidant', 'Vitamin E. Protects the oils in the formula and skin lipids from oxidation.'],
    [['ferulic acid'], 'Antioxidant', 'Stabilizes vitamins C and E and boosts their antioxidant effect.'],
    [['camellia sinensis leaf extract', 'green tea extract'], 'Antioxidant', 'Green tea. Its polyphenols are antioxidant and calming.'],
    [['resveratrol'], 'Antioxidant', 'A grape-derived antioxidant.'],
    [['palmitoyl tripeptide-1', 'palmitoyl tetrapeptide-7', 'palmitoyl pentapeptide-4', 'acetyl hexapeptide-8', 'copper tripeptide-1'], 'Peptide', 'A short chain of amino acids that acts as a signal to skin. The evidence varies a lot by peptide.'],
    [['parfum', 'fragrance', 'aroma'], 'Fragrance', 'Scent. Can be dozens of undisclosed compounds and is a common cause of irritation.'],
    [['limonene', 'linalool', 'citronellol', 'geraniol', 'citral', 'eugenol', 'coumarin', 'benzyl salicylate', 'hexyl cinnamal', 'benzyl benzoate'], 'Fragrance allergen', 'A fragrance component that has to be listed by name in the EU because some people are allergic to it.'],
    [['mica', 'ci 77019'], 'Colorant', 'A mineral that adds shimmer.'],
    [['iron oxides', 'ci 77491', 'ci 77492', 'ci 77499'], 'Colorant', 'Mineral pigments that give red, yellow and black tones.'],
    [['silica'], 'Texture', 'Absorbs oil and gives a soft, matte finish.'],
    [['kaolin'], 'Absorbent', 'A white clay that soaks up oil.'],
    [['zinc pca'], 'Active', 'Zinc bound to PCA. Helps regulate oil.'],
    [['adenosine'], 'Active', 'A skin-signalling molecule used in anti-wrinkle claims, especially in Korean formulas.'],
    [['caffeine'], 'Active', 'Constricts blood vessels a little, which is why it shows up in eye creams for puffiness.']
  ];

  var RULES = [
    [/paraben$/, 'Preservative', 'A paraben. Very effective and well studied at the levels used in cosmetics.'],
    [/^peg-\d+/, 'Emulsifier', 'A PEG compound that helps oil and water mix or cleansers rinse clean.'],
    [/(siloxane|cone)$/, 'Silicone', 'A silicone. Gives slip and a smooth finish.'],
    [/\boil$/, 'Emollient', 'A plant or synthetic oil. Softens skin and slows water loss.'],
    [/\bbutter$/, 'Emollient', 'A rich fat that softens and seals.'],
    [/\bextract$/, 'Plant extract', 'A plant extract. Effects depend on the plant and how much is in there; low on the list it is mostly for the label.'],
    [/\bwater$/, 'Plant water', 'A hydrosol or plant water used as part of the base.'],
    [/^ci \d{5}/, 'Colorant', 'A color additive, listed by its Colour Index number.'],
    [/sulfate$/, 'Surfactant', 'A sulfate cleansing agent.'],
    [/glucoside$/, 'Surfactant', 'A gentle sugar-based cleanser.'],
    [/ceramide/, 'Barrier lipid', 'A ceramide, one of the lipids that hold skin cells together.'],
    [/peptide/, 'Peptide', 'A peptide. A signalling molecule; evidence depends on the specific one.'],
    [/ferment|lysate/, 'Ferment', 'A fermented ingredient. Mostly hydrating; specific claims vary.'],
    [/glycol$/, 'Humectant', 'A glycol. Hydrates and helps the formula spread.'],
    [/ate$/, 'Ingredient', 'A salt or ester. Look it up by name for its exact role.']
  ];

  var SAMPLES = {
    moisturizer: 'Aqua, Glycerin, Butylene Glycol, Niacinamide, Squalane, Dimethicone, Sodium Hyaluronate, Panthenol, Ceramide NP, Cholesterol, Carbomer, Sodium Hydroxide, Allantoin, Disodium EDTA, Phenoxyethanol, Ethylhexylglycerin',
    serum: 'Aqua, Ascorbic Acid, Ethoxydiglycol, Propylene Glycol, Glycerin, Tocopherol, Ferulic Acid, Sodium Hyaluronate, Triethanolamine, Phenoxyethanol, Panthenol',
    cleanser: 'Aqua, Sodium Laureth Sulfate, Cocamidopropyl Betaine, Glycerin, Coco-Glucoside, Sodium Chloride, Citric Acid, Sodium Benzoate, Parfum, Limonene'
  };

  var index = {};
  DICT.forEach(function (d) { d[0].forEach(function (n) { index[n] = d; }); });

  function norm(s) {
    return s.toLowerCase().replace(/\s+/g, ' ').replace(/[*.]+$/, '').trim();
  }

  // separa por comas fuera de paréntesis
  function split(text) {
    var parts = [], depth = 0, cur = '';
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (c === '(' || c === '[') depth++;
      if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
      if ((c === ',' || c === '\n' || c === ';') && depth === 0) { parts.push(cur); cur = ''; } else cur += c;
    }
    parts.push(cur);
    return parts.map(function (p) { return p.replace(/^\s*(ingredients?|inci)\s*:\s*/i, '').trim(); }).filter(Boolean);
  }

  function lookup(raw) {
    var n = norm(raw);
    if (index[n]) return index[n];
    var base = norm(n.replace(/\(.*?\)/g, ' '));
    if (index[base]) return index[base];
    var inside = (n.match(/\((.*?)\)/) || [])[1];
    if (inside && index[norm(inside)]) return index[norm(inside)];
    var slash = n.split('/').map(norm);
    for (var i = 0; i < slash.length; i++) if (index[slash[i]]) return index[slash[i]];
    for (var r = 0; r < RULES.length; r++) if (RULES[r][0].test(base)) return [null, RULES[r][1], RULES[r][2]];
    return null;
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function decode(text) {
    var items = split(text);
    out.textContent = '';
    if (!items.length) {
      out.appendChild(el('p', 'decoder__hint', 'Paste an ingredient list first. It is usually on the back of the box, after the word "Ingredients".'));
      return;
    }
    var known = 0, preservativeAt = -1, roles = {};
    var rows = items.map(function (name, i) {
      var hit = lookup(name);
      if (hit) {
        known++;
        roles[hit[1]] = (roles[hit[1]] || 0) + 1;
        if (preservativeAt < 0 && /^Preservative$/.test(hit[1])) preservativeAt = i;
      }
      return { name: name, hit: hit };
    });

    var top = rows.slice(0, 5).filter(function (r) { return r.hit; }).map(function (r) { return r.hit[1].toLowerCase(); });
    var summary = items.length + ' ingredients, ' + known + ' explained below.';
    if (roles.Active) summary += ' ' + roles.Active + (roles.Active === 1 ? ' active ingredient' : ' active ingredients') + ' in here.';
    if (roles.Fragrance || roles['Fragrance allergen']) summary += ' Contains fragrance.';
    out.appendChild(el('p', 'dec-summary', summary));

    var list = el('ol', 'dec-list');
    rows.forEach(function (r, i) {
      if (i === preservativeAt && i > 0) {
        var cut = el('li', 'dec-cut', 'From here on, each ingredient is probably under 1% of the formula.');
        list.appendChild(cut);
      }
      var li = el('li', 'dec-item');
      li.style.setProperty('--i', Math.min(i, 20));
      li.appendChild(el('span', 'dec-pos', String(i + 1)));
      li.appendChild(el('span', 'dec-name', r.name));
      li.appendChild(el('span', 'dec-role' + (r.hit ? '' : ' dec-role--unknown'), r.hit ? r.hit[1] : 'Not in my notes yet'));
      li.appendChild(el('span', 'dec-what', r.hit ? r.hit[2] : 'Search the exact name, or send it to Sofia on Instagram and it may become a post.'));
      list.appendChild(li);
    });
    out.appendChild(list);
    if (top.length) out.setAttribute('data-top', top.join(','));
  }

  // Abre con una etiqueta de ejemplo ya decodificada
  if (!form.inci.value) { form.inci.value = SAMPLES.moisturizer; decode(form.inci.value); }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    decode(form.inci.value);
  });
  form.querySelectorAll('[data-sample]').forEach(function (b) {
    b.addEventListener('click', function () {
      form.inci.value = SAMPLES[b.getAttribute('data-sample')];
      decode(form.inci.value);
    });
  });
})();
