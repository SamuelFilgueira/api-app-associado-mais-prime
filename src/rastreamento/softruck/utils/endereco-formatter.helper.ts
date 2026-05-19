export interface NominatimAddress {
  road?: string;
  house_number?: string;
  hamlet?: string;
  suburb?: string;
  neighbourhood?: string;
  city?: string;
  town?: string;
  village?: string;
  state?: string;
}

export function formatarEnderecoNominatim(address: NominatimAddress): string | null {
  const numero = address.house_number ?? address.hamlet;
  const bairro = address.suburb ?? address.neighbourhood;
  const cidade = address.city ?? address.town ?? address.village;

  const logradouroComNumero = [address.road, numero].filter(Boolean).join(', ');

  const endereco = [logradouroComNumero, bairro, cidade, address.state]
    .filter(Boolean)
    .join(' - ');

  return endereco || null;
}
