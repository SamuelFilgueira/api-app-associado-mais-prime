export interface JwtUser {
  userId: number;
  cpf: string;
  username: string;
  role: string;
  baseOrigin: 'MAIS_PRIME' | 'MAIS_PRIME_RS';
}
