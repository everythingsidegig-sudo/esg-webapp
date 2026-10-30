// Hand-written types matching the additive Supabase migrations.
// Kept intentionally minimal (only what the app queries) rather than full generated types.

export type GigStatus =
  | "draft"
  | "active"
  | "in_progress"
  | "awaiting_payment"
  | "completed"
  | "incomplete"
  | "disputed"
  | "cancelled";

export type PriceType = "fixed" | "negotiable";
export type ClaimState = "pending" | "selected" | "rejected" | "withdrawn";
export type CompletionOutcome = "complete" | "incomplete";
export type IncompleteChoice = "partial_pay" | "no_pay";
export type FeedbackType = "wom" | "lemon" | "skip";

export interface Profile {
  id: string;
  username: string;
  photo_url: string | null;
  skills: string[];
  services: string[];
  wom_count: number;
  lemon_count: number;
  money_made: number;
  created_at: string;
  private_location_text: string | null;
  private_lat: number | null;
  private_lng: number | null;
  public_location_text: string | null;
  public_lat: number | null;
  public_lng: number | null;
  onboarding_completed_at: string | null;
  phone: string | null;
  terms_accepted_at: string | null;
  skills_other_text: string | null;
  services_other_text: string | null;
}

export interface PublicProfile {
  id: string;
  username: string;
  photo_url: string | null;
  skills: string[];
  wom_count: number;
  public_location_text: string | null;
  public_lat: number | null;
  public_lng: number | null;
}

export interface ProfileTag {
  profile_id: string;
  tag_id: string;
}

// Shape produced by withProfileTags() in lib/tags.ts (profile_tags cannot be embedded from public_profiles).
export type PublicProfileWithTags = PublicProfile & { profile_tags?: { tag: { id: string; name: string; service_type: string } }[] };

export interface Gig {
  id: string;
  creation_request_id: string | null;
  poster_id: string;
  service_type: string;
  title: string;
  description: string;
  photo_url: string | null;
  amount: number;
  // Set server-side from the accepted offer when a helper is selected; `amount` stays the posted budget.
  agreed_amount: number | null;
  price_type: PriceType;
  // Set when the gig is a private request to one helper (migration 0019); null for every public gig.
  requested_helper_id: string | null;
  scheduled_at: string | null;
  location_text: string | null;
  lat: number | null;
  lng: number | null;
  status: GigStatus;
  selected_provider_id: string | null;
  start_requested_at: string | null;
  start_approved_at: string | null;
  // Migration 0022: the poster delayed a start request / the helper withdrew while it was delayed.
  start_delayed_at: string | null;
  helper_withdrawn_at: string | null;
  resolution_path: "complete" | "partial_pay" | null;
  incomplete_choice_phase: boolean;
  amount_paid: number | null;
  amount_received: number | null;
  created_at: string;
}

export interface Tag {
  id: string;
  service_type: string;
  name: string;
  created_at: string;
}

export interface GigTag {
  gig_id: string;
  tag_id: string;
}

// PostgREST embed shape: gigs.select("*, gig_tags(tag:tags(id,name))").
export type GigWithTags = Gig & { gig_tags?: { tag: { id: string; name: string } }[] };

export interface Claim {
  id: string;
  gig_id: string;
  provider_id: string;
  state: ClaimState;
  offer_amount: number;
  message: string | null;
  created_at: string;
}

// Readable only by the poster and the accepted helper (enforced by RLS).
export interface GigPrivateLocation {
  gig_id: string;
  address_text: string;
  created_at: string;
}

export interface ChatMessage {
  id: string;
  gig_id: string;
  sender_id: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

export type PriceProposalState = "pending" | "accepted" | "declined" | "withdrawn";

// A price proposed from the gig chat (migration 0021). amount is the proposal, from_amount the
// agreed price it started from; round counts proposals on the gig (at most three).
export interface PriceProposal {
  id: string;
  gig_id: string;
  proposer_id: string;
  round: number;
  from_amount: number;
  amount: number;
  state: PriceProposalState;
  created_at: string;
  responded_at: string | null;
}

export interface Notification {
  id: string;
  recipient_id: string;
  gig_id: string | null;
  type: string;
  message: string;
  read: boolean;
  created_at: string;
}

export interface Database {
  public: {
    Tables: {
      profiles: { Row: Profile; Insert: Partial<Profile>; Update: Partial<Profile> };
      public_profiles: { Row: PublicProfile; Insert: Partial<PublicProfile>; Update: Partial<PublicProfile> };
      gigs: { Row: Gig; Insert: Partial<Gig>; Update: Partial<Gig> };
      tags: { Row: Tag; Insert: Partial<Tag>; Update: Partial<Tag> };
      gig_tags: { Row: GigTag; Insert: Partial<GigTag>; Update: Partial<GigTag> };
      profile_tags: { Row: ProfileTag; Insert: Partial<ProfileTag>; Update: Partial<ProfileTag> };
      claims: { Row: Claim; Insert: Partial<Claim>; Update: Partial<Claim> };
      gig_private_locations: { Row: GigPrivateLocation; Insert: Partial<GigPrivateLocation>; Update: Partial<GigPrivateLocation> };
      chat_messages: { Row: ChatMessage; Insert: Partial<ChatMessage>; Update: Partial<ChatMessage> };
      notifications: { Row: Notification; Insert: Partial<Notification>; Update: Partial<Notification> };
      price_proposals: { Row: PriceProposal; Insert: Partial<PriceProposal>; Update: Partial<PriceProposal> };
    };
    Functions: {
      ensure_profile: { Args: Record<string, never>; Returns: Profile };
      save_onboarding: { Args: { p_username: string; p_photo_url: string | null; p_location_text: string; p_lat: number | null; p_lng: number | null; p_skills: string[]; p_services: string[] }; Returns: Profile };
      create_gig: { Args: { p_request_id: string; p_service_type: string; p_title: string; p_description: string; p_amount: number; p_price_type: string; p_scheduled_at: string | null; p_location_text: string; p_lat: number | null; p_lng: number | null; p_photo_url?: string | null; p_publish?: boolean; p_tag_ids?: string[]; p_private_address?: string | null; p_requested_helper_id?: string | null }; Returns: Gig };
      create_claim: { Args: { p_gig_id: string; p_offer_amount?: number | null; p_message?: string | null }; Returns: Claim };
      withdraw_claim: { Args: { p_gig_id: string }; Returns: void };
      delay_start: { Args: { p_gig_id: string }; Returns: void };
      withdraw_from_gig: { Args: { p_gig_id: string }; Returns: void };
      propose_price: { Args: { p_gig_id: string; p_amount: number }; Returns: PriceProposal };
      respond_price_proposal: { Args: { p_proposal_id: string; p_accept: boolean }; Returns: void };
      withdraw_price_proposal: { Args: { p_proposal_id: string }; Returns: void };
      accept_gig_request: { Args: { p_gig_id: string }; Returns: void };
      decline_gig_request: { Args: { p_gig_id: string }; Returns: void };
      reassign_gig_request: { Args: { p_gig_id: string; p_new_helper_id?: string | null }; Returns: void };
      select_provider: { Args: { p_gig_id: string; p_claim_id: string }; Returns: void };
      request_start: { Args: { p_gig_id: string }; Returns: void };
      approve_start: { Args: { p_gig_id: string }; Returns: void };
      submit_completion: { Args: { p_gig_id: string; p_outcome: CompletionOutcome }; Returns: void };
      submit_incomplete_choice: { Args: { p_gig_id: string; p_choice: IncompleteChoice }; Returns: void };
      submit_payment_amount: { Args: { p_gig_id: string; p_amount: number }; Returns: void };
      submit_feedback: { Args: { p_gig_id: string; p_type: FeedbackType }; Returns: void };
      publish_gig: { Args: { p_gig_id: string }; Returns: void };
      cancel_gig: { Args: { p_gig_id: string }; Returns: void };
      get_public_stats: { Args: { p_profile_id: string }; Returns: { gigs_worked_count: number; wom_count: number; wom_percentage: number | null }[] };
      check_deletion_eligibility: { Args: Record<string, never>; Returns: { eligible: boolean; active_gigs_count: number; open_disputes_count: number }[] };
      email_registered: { Args: { p_email: string }; Returns: boolean };
      complete_registration: {
        Args: {
          p_username: string; p_photo_url: string | null; p_phone: string | null;
          p_skills: string[]; p_services: string[]; p_skills_other: string | null; p_services_other: string | null;
          p_terms_accepted: boolean;
        };
        Returns: Profile;
      };
      set_helper_tags: { Args: { p_service_type: string; p_tag_ids: string[] }; Returns: void };
      set_helper_location: { Args: { p_location_text: string | null; p_lat: number | null; p_lng: number | null }; Returns: Profile };
    };
  };
}
