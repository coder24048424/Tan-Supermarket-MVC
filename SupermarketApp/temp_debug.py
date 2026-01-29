from pathlib import Path
lines = Path('public/css/main.css').read_text().splitlines()
for i,line in enumerate(lines):
    if 'payment-method-btn.paypal-main' in line:
        for l in lines[i-5:i+30]:
            print(l)
        break

